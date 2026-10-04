/**
 * Phone-side listener.
 *
 * Accepts authenticated commands from paired controllers and forwards them to
 * the single StateManager. The server holds no state of its own: it decrypts,
 * validates, and submits. Every rejection path returns before the engine is
 * touched, except DUPLICATE, which is submitted deliberately so the engine can
 * answer from its exactly-once cache without performing work twice.
 */

import * as net from 'node:net';
import { randomUUID } from 'node:crypto';

import type { AuditLog } from '../core/audit-log.ts';
import type { Clock } from '../core/clock.ts';
import type { StateManager } from '../core/state-manager.ts';
import type { Command, CommandResult } from '../core/types.ts';
import type { CommandPayload } from '../protocol/envelope.ts';
import { NonceSource, open, seal } from '../protocol/envelope.ts';
import { encodeFrame, FrameDecoder } from '../protocol/framing.ts';
import type { DirectionalKeys } from '../protocol/pairing.ts';
import { deriveKeys, secretOf } from '../protocol/pairing.ts';
import type { PairingStore } from '../protocol/pairing-store.ts';
import type { ReplayGuard } from '../protocol/replay-guard.ts';
import type { DeviceMessage, ControllerMessage, HelloAck } from '../protocol/session.ts';
import { DEFAULT_PORT, HEARTBEAT_TIMEOUT_MS, isControllerMessage } from '../protocol/session.ts';

export type DeviceServerOptions = {
  readonly deviceId: string;
  readonly engine: StateManager;
  readonly pairings: PairingStore;
  readonly replay: ReplayGuard;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly port?: number;
  readonly host?: string;
  /** Commands the controller is allowed to issue remotely. */
  readonly allowed?: readonly Command['type'][];
};

const REMOTE_ALLOWED: readonly Command['type'][] = ['LOCKDOWN', 'RESTORE', 'TOGGLE', 'STATUS'];

export class DeviceServer {
  readonly #opts: DeviceServerOptions;
  readonly #keys: Map<string, DirectionalKeys> = new Map();
  readonly #nonces: Map<string, NonceSource> = new Map();
  #server: net.Server | null = null;
  #sockets = new Set<net.Socket>();
  /** commandIds processed in this process, for the HELLO_ACK settle list. */
  #processed: string[] = [];

  constructor(options: DeviceServerOptions) {
    this.#opts = options;
  }

  async listen(): Promise<{ port: number; host: string }> {
    await this.#opts.pairings.load();
    for (const record of this.#opts.pairings.all()) {
      this.#keys.set(record.deviceId, deriveKeys(secretOf(record), record.deviceId));
    }
    // Reserve a nonce counter block up front, so a crash can never cause a
    // counter value to be reused for this key.
    const base = await this.#opts.replay.reserveSendCounter();
    this.#nonces.set(this.#opts.deviceId, new NonceSource(base));

    const server = net.createServer((socket) => this.#onConnection(socket));
    this.#server = server;

    const host = this.#opts.host ?? '0.0.0.0';
    const port = this.#opts.port ?? DEFAULT_PORT;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    const actualPort = typeof address === 'object' && address !== null ? address.port : port;
    return { port: actualPort, host };
  }

  async close(): Promise<void> {
    for (const socket of [...this.#sockets]) socket.destroy();
    this.#sockets.clear();
    const server = this.#server;
    this.#server = null;
    if (server === null) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  get connectionCount(): number {
    return this.#sockets.size;
  }

  #onConnection(socket: net.Socket): void {
    this.#sockets.add(socket);
    socket.setNoDelay(true);
    // A half-open connection is dropped rather than held: the controller
    // reconnects and resumes, which is always safe.
    socket.setTimeout(HEARTBEAT_TIMEOUT_MS, () => socket.destroy());

    const decoder = new FrameDecoder();
    /** Serialises this connection's frames so two cannot be in flight at once. */
    let chain: Promise<void> = Promise.resolve();

    socket.on('data', (chunk: Buffer) => {
      const { frames, error } = decoder.push(chunk);
      for (const frame of frames) {
        chain = chain.then(() => this.#handleFrame(socket, frame)).catch(() => undefined);
      }
      if (error !== undefined) {
        chain = chain.then(() => {
          socket.destroy();
        });
      }
    });

    socket.on('error', () => socket.destroy());
    socket.on('close', () => this.#sockets.delete(socket));
  }

  async #handleFrame(socket: net.Socket, frame: unknown): Promise<void> {
    // Identify which pairing this frame claims to be from, without trusting it:
    // the key selected by `deviceId` must successfully authenticate the frame.
    const claimed = (frame as { deviceId?: unknown }).deviceId;
    if (typeof claimed !== 'string' || claimed !== this.#opts.deviceId) {
      await this.#audit('link.unknown-device', 'REJECTED', 'frame not addressed to this device');
      socket.destroy();
      return;
    }
    const keys = this.#keys.get(this.#opts.deviceId);
    if (keys === undefined) {
      await this.#audit('link.unpaired', 'REJECTED', 'no pairing on record');
      socket.destroy();
      return;
    }

    const opened = open<ControllerMessage>(frame, keys.controllerToDevice, this.#opts.deviceId);
    if (!opened.ok) {
      // Unauthenticated traffic is dropped silently and the connection closed.
      await this.#audit('link.auth-failed', 'REJECTED', opened.reason);
      socket.destroy();
      return;
    }
    const message = opened.value;
    if (!isControllerMessage(message)) {
      await this.#audit('link.malformed', 'REJECTED', 'unknown message type');
      socket.destroy();
      return;
    }

    switch (message.type) {
      case 'HELLO': {
        const status = this.#opts.engine.status;
        const ack: HelloAck = {
          type: 'HELLO_ACK',
          highestSeq: this.#opts.replay.highestSeq,
          state: status.state,
          lockdownId: status.activeLockdownId,
          restoreDeadline: status.restoreDeadline,
          serverTime: this.#opts.clock.now(),
          processed: this.#processed.slice(-64),
        };
        await this.#audit('link.hello', 'ACCEPTED', `session=${message.sessionId.slice(0, 8)}`);
        this.#send(socket, ack);
        return;
      }

      case 'PING': {
        this.#send(socket, { type: 'PONG', at: this.#opts.clock.now(), state: this.#opts.engine.status.state });
        return;
      }

      case 'COMMAND': {
        await this.#handleCommand(socket, message.command);
        return;
      }

      default: {
        const _exhaustive: never = message;
        socket.destroy();
      }
    }
  }

  async #handleCommand(socket: net.Socket, payload: CommandPayload): Promise<void> {
    const allowed = this.#opts.allowed ?? REMOTE_ALLOWED;
    if (!allowed.includes(payload.type)) {
      // TIMEOUT and RECOVER are internal only: a controller must never be able
      // to inject a fenced callback for a transaction it does not own.
      this.#send(socket, {
        type: 'REJECT',
        inReplyTo: payload.commandId ?? null,
        code: 'FORBIDDEN_TYPE',
        reason: `${String(payload.type)} cannot be issued remotely`,
      });
      await this.#audit('command.forbidden', 'REJECTED', String(payload.type));
      return;
    }

    const now = this.#opts.clock.now();
    const verdict = this.#opts.replay.check({
      commandId: payload.commandId,
      seq: payload.seq,
      timestamp: payload.timestamp,
      expiresAt: payload.expiresAt,
      now,
    });

    if (!verdict.ok && verdict.code !== 'DUPLICATE') {
      this.#send(socket, {
        type: 'REJECT',
        inReplyTo: payload.commandId ?? null,
        code: verdict.code,
        reason: verdict.reason,
      });
      await this.#audit(`command.${verdict.code.toLowerCase()}`, 'REJECTED', verdict.reason);
      return;
    }

    const cached = !verdict.ok; // DUPLICATE: the engine answers from its cache.

    const command: Command = {
      commandId: payload.commandId,
      deviceId: payload.deviceId,
      type: payload.type,
      lockdownId: payload.lockdownId ?? null,
      timestamp: payload.timestamp,
      expiresAt: payload.expiresAt,
      origin: 'controller',
    };

    const result: CommandResult = await this.#opts.engine.submit(command);

    if (!cached) {
      // Durable before the reply leaves, so a crash cannot reopen the window.
      await this.#opts.replay.accept(payload.commandId, payload.seq);
      this.#processed.push(payload.commandId);
      if (this.#processed.length > 128) this.#processed = this.#processed.slice(-128);
    }

    this.#send(socket, {
      type: 'REPLY',
      inReplyTo: payload.commandId,
      seq: payload.seq,
      result,
      cached,
    });
  }

  #send(socket: net.Socket, message: DeviceMessage): void {
    const keys = this.#keys.get(this.#opts.deviceId);
    const nonces = this.#nonces.get(this.#opts.deviceId);
    if (keys === undefined || nonces === undefined || socket.destroyed) return;
    const envelope = seal(message, keys.deviceToController, this.#opts.deviceId, nonces.next());
    try {
      socket.write(encodeFrame(envelope));
    } catch {
      socket.destroy();
    }
  }

  async #audit(operation: string, result: string, error: string | null): Promise<void> {
    await this.#opts.audit.append({
      timestamp: this.#opts.clock.now(),
      deviceId: this.#opts.deviceId,
      operation,
      result,
      error,
      commandId: null,
      lockdownId: null,
    });
  }
}

export function newSessionId(): string {
  return randomUUID();
}
