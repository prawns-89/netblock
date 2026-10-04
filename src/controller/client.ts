/**
 * Controller-side client, built around the assumption that the link WILL die.
 *
 * A successful lockdown disables the Wi-Fi the command arrived over, so the
 * reply to a LOCKDOWN frequently never comes back. That is not an error
 * condition here, it is the expected path, and it is handled without ever
 * leaving the outcome to chance:
 *
 *  1. Every command is written to a durable outbox before it is sent.
 *  2. If the link drops before the reply, the command is reported UNCONFIRMED
 *     rather than guessed at.
 *  3. On reconnect, HELLO_ACK carries the device's processed-commandId list and
 *     its live lockdown state, so the controller settles each outstanding entry
 *     against what the device actually did.
 *  4. Anything still unsettled and still inside its TTL is resent with the SAME
 *     commandId and a FRESH seq. The device's exactly-once cache makes a
 *     redundant resend harmless; the fresh seq makes a genuinely lost command
 *     acceptable to the ordering check.
 */

import * as net from 'node:net';
import { randomUUID } from 'node:crypto';

import type { Clock } from '../core/clock.ts';
import type { AtomicFs } from '../core/fs-port.ts';
import type { Command, CommandResult, CommandType, LockdownState } from '../core/types.ts';
import type { CommandPayload } from '../protocol/envelope.ts';
import { NonceSource, open, seal } from '../protocol/envelope.ts';
import { encodeFrame, FrameDecoder } from '../protocol/framing.ts';
import type { DirectionalKeys, PairingRecord } from '../protocol/pairing.ts';
import { deriveKeys, secretOf } from '../protocol/pairing.ts';
import type { ControllerMessage, DeviceMessage } from '../protocol/session.ts';
import {
  COMMAND_TTL_MS,
  DEFAULT_PORT,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  isDeviceMessage,
} from '../protocol/session.ts';

const OUTBOX_KEY = 'outbox.json';
const MAX_BACKOFF_MS = 15_000;
const BASE_BACKOFF_MS = 250;
/**
 * A peer can accept a TCP connection and then never answer — a half-open
 * connection through a NAT, a captive portal, or a phone whose Wi-Fi died
 * between the SYN and the reply. Without a deadline the client would wait on
 * that socket forever and never reconnect, so the handshake is bounded.
 */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

export type LinkState = 'offline' | 'connecting' | 'ready';

/**
 * Connections that are accepted and then dropped before HELLO_ACK look the same
 * whether the phone rejected our key or the network silently ate the reply. So
 * the client never stops retrying — a flaky link must always heal by itself —
 * but after this many consecutive handshake failures it publishes a diagnosis,
 * so the owner is told to re-pair instead of being left guessing.
 */
const HANDSHAKE_FAILURES_BEFORE_DIAGNOSIS = 3;

export type SendOutcome =
  | { readonly outcome: 'ACKED'; readonly commandId: string; readonly result: CommandResult; readonly cached: boolean }
  | { readonly outcome: 'REJECTED'; readonly commandId: string; readonly code: string; readonly reason: string }
  | { readonly outcome: 'UNCONFIRMED'; readonly commandId: string; readonly detail: string };

type OutboxEntry = {
  readonly commandId: string;
  readonly type: CommandType;
  readonly lockdownId: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  sends: number;
};

type Pending = {
  readonly entry: OutboxEntry;
  resolve: (outcome: SendOutcome) => void;
  settled: boolean;
};

export type DeviceSnapshotView = {
  readonly state: LockdownState;
  readonly lockdownId: string | null;
  readonly restoreDeadline: number | null;
  readonly serverTime: number;
};

export type ControllerClientOptions = {
  readonly pairing: PairingRecord;
  readonly host: string;
  readonly port?: number;
  readonly fs: AtomicFs;
  readonly clock: Clock;
  readonly onEvent?: (event: string, detail?: string) => void;
  readonly nonceBase?: bigint;
  /** How long to wait for HELLO_ACK before dropping the socket and retrying. */
  readonly handshakeTimeoutMs?: number;
};

export class ControllerClient {
  readonly #opts: ControllerClientOptions;
  readonly #keys: DirectionalKeys;
  readonly #nonces: NonceSource;
  readonly #sessionId = randomUUID();

  #socket: net.Socket | null = null;
  #decoder = new FrameDecoder();
  #state: LinkState = 'offline';
  #seq = 0;
  #outbox: OutboxEntry[] = [];
  #pending = new Map<string, Pending>();
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #attempt = 0;
  #stopped = false;
  #lastView: DeviceSnapshotView | null = null;
  #readyWaiters: (() => void)[] = [];
  #handshakeFailures = 0;
  #handshakeDone = false;
  #diagnosis: string | null = null;
  #handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ControllerClientOptions) {
    this.#opts = options;
    this.#keys = deriveKeys(secretOf(options.pairing), options.pairing.deviceId);
    this.#nonces = new NonceSource(options.nonceBase ?? 0n);
  }

  get linkState(): LinkState {
    return this.#state;
  }

  /**
   * A human-readable explanation when the link repeatedly fails to come up.
   * Reconnection continues regardless; this exists so the caller can report the
   * likely cause instead of a bare "unreachable".
   */
  get diagnosis(): string | null {
    return this.#diagnosis;
  }

  get handshakeFailures(): number {
    return this.#handshakeFailures;
  }

  get deviceView(): DeviceSnapshotView | null {
    return this.#lastView;
  }

  get outstanding(): readonly { commandId: string; type: CommandType; sends: number }[] {
    return this.#outbox.map((e) => ({ commandId: e.commandId, type: e.type, sends: e.sends }));
  }

  async start(): Promise<void> {
    await this.#loadOutbox();
    this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#clearTimers();
    this.#socket?.destroy();
    this.#socket = null;
    this.#state = 'offline';
    for (const pending of this.#pending.values()) {
      if (!pending.settled) {
        pending.settled = true;
        pending.resolve({
          outcome: 'UNCONFIRMED',
          commandId: pending.entry.commandId,
          detail: 'controller stopped before the reply arrived',
        });
      }
    }
    this.#pending.clear();
  }

  /** Resolves once the link has completed a handshake, or times out. */
  async waitForReady(timeoutMs = 5_000): Promise<boolean> {
    if (this.#state === 'ready') return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.#readyWaiters = this.#readyWaiters.filter((w) => w !== waiter);
        resolve(this.#state === 'ready');
      }, timeoutMs);
      timer.unref?.();
      const waiter = () => {
        clearTimeout(timer);
        resolve(this.#state === 'ready');
      };
      this.#readyWaiters.push(waiter);
    });
  }

  /**
   * Issue a command. The returned promise settles when the device replies, when
   * the device rejects it, or when the command's TTL elapses without an answer.
   * An UNCONFIRMED result is not a failure: it means the true outcome is
   * knowable only after the link returns, and the outbox will settle it then.
   */
  async send(type: CommandType, options: { lockdownId?: string | null; ttlMs?: number } = {}): Promise<SendOutcome> {
    const now = this.#opts.clock.now();
    const entry: OutboxEntry = {
      commandId: randomUUID(),
      type,
      lockdownId: options.lockdownId ?? null,
      createdAt: now,
      expiresAt: now + (options.ttlMs ?? COMMAND_TTL_MS),
      sends: 0,
    };
    this.#outbox = [...this.#outbox, entry];
    await this.#saveOutbox();

    const promise = new Promise<SendOutcome>((resolve) => {
      this.#pending.set(entry.commandId, { entry, resolve, settled: false });
    });

    // Settle with UNCONFIRMED when the TTL passes with no answer, so a caller
    // never waits indefinitely on a link the lockdown just severed.
    const ttlTimer = setTimeout(
      () => {
        this.#settle(entry.commandId, {
          outcome: 'UNCONFIRMED',
          commandId: entry.commandId,
          detail: 'no reply before the command expired; will be reconciled on reconnect',
        });
      },
      Math.max(0, entry.expiresAt - now) + 250,
    );
    ttlTimer.unref?.();

    this.#trySend(entry);
    return promise;
  }

  // =====================================================================
  // Connection lifecycle
  // =====================================================================

  #connect(): void {
    if (this.#stopped || this.#socket !== null) return;
    this.#state = 'connecting';
    this.#decoder = new FrameDecoder();

    const socket = net.createConnection({
      host: this.#opts.host,
      port: this.#opts.port ?? DEFAULT_PORT,
    });
    this.#socket = socket;
    socket.setNoDelay(true);

    // An established but silent connection is dropped, so a dead link is
    // noticed rather than waited on indefinitely.
    socket.setTimeout(HEARTBEAT_TIMEOUT_MS, () => {
      this.#emit('link.idle-timeout');
      socket.destroy();
    });

    socket.on('connect', () => {
      // Deliberately NOT resetting the backoff attempt counter here: a server
      // that accepts and immediately drops us must still be backed off, or the
      // client spins in a tight connect/close loop. Only a completed handshake
      // counts as success.
      this.#handshakeDone = false;
      this.#armHandshakeTimeout(socket);
      this.#emit('link.connected', `${this.#opts.host}:${String(this.#opts.port ?? DEFAULT_PORT)}`);
      this.#write({
        type: 'HELLO',
        sessionId: this.#sessionId,
        lastSentSeq: this.#seq,
        sentAt: this.#opts.clock.now(),
      });
    });

    socket.on('data', (chunk: Buffer) => {
      const { frames, error } = this.#decoder.push(chunk);
      for (const frame of frames) this.#onFrame(frame);
      if (error !== undefined) {
        this.#emit('link.protocol-error', error);
        socket.destroy();
      }
    });

    socket.on('error', (err: Error) => {
      this.#emit('link.error', err.message);
    });

    socket.on('close', () => {
      this.#socket = null;
      this.#clearHandshakeTimeout();
      this.#clearHeartbeat();

      if (!this.#handshakeDone) {
        this.#handshakeFailures += 1;
        if (this.#handshakeFailures >= HANDSHAKE_FAILURES_BEFORE_DIAGNOSIS) {
          this.#diagnosis =
            `the phone accepted the connection but the handshake never completed (${String(this.#handshakeFailures)} attempts). ` +
            'Either it no longer holds this pairing key — re-pair — or the link is dropping our replies. Retrying.';
          this.#emit('link.handshake-failing', this.#diagnosis);
        }
      }

      this.#state = 'offline';
      this.#emit('link.closed');
      this.#scheduleReconnect();
    });
  }

  #armHandshakeTimeout(socket: net.Socket): void {
    this.#clearHandshakeTimeout();
    const limit = this.#opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.#handshakeTimer = setTimeout(() => {
      this.#handshakeTimer = null;
      if (this.#handshakeDone) return;
      this.#emit('link.handshake-timeout', `no HELLO_ACK within ${String(limit)}ms`);
      // Dropping the socket puts us back on the reconnect path, which is the
      // only state from which the link can recover.
      socket.destroy();
    }, limit);
    this.#handshakeTimer.unref?.();
  }

  #clearHandshakeTimeout(): void {
    if (this.#handshakeTimer !== null) {
      clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = null;
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer !== null) return;
    this.#attempt += 1;
    // Exponential backoff with jitter, so a phone that is down does not get
    // hammered and many controllers do not synchronise their retries.
    const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(this.#attempt, 8));
    const delay = Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
    this.#emit('link.reconnect-scheduled', `${String(delay)}ms (attempt ${String(this.#attempt)})`);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #onFrame(frame: unknown): void {
    const opened = open<DeviceMessage>(frame, this.#keys.deviceToController, this.#opts.pairing.deviceId);
    if (!opened.ok) {
      this.#emit('link.auth-failed', opened.reason);
      this.#socket?.destroy();
      return;
    }
    const message = opened.value;
    if (!isDeviceMessage(message)) {
      this.#socket?.destroy();
      return;
    }

    switch (message.type) {
      case 'HELLO_ACK': {
        // Never let our frame sequence regress below what the device has seen.
        this.#seq = Math.max(this.#seq, message.highestSeq);
        this.#lastView = {
          state: message.state,
          lockdownId: message.lockdownId,
          restoreDeadline: message.restoreDeadline,
          serverTime: message.serverTime,
        };
        this.#state = 'ready';
        this.#handshakeDone = true;
        this.#clearHandshakeTimeout();
        this.#handshakeFailures = 0;
        this.#attempt = 0;
        this.#diagnosis = null;
        this.#emit('link.ready', `device state=${message.state}`);
        void this.#reconcile(message.processed);
        this.#startHeartbeat();
        for (const waiter of this.#readyWaiters.splice(0)) waiter();
        return;
      }

      case 'REPLY': {
        this.#settle(message.inReplyTo, {
          outcome: 'ACKED',
          commandId: message.inReplyTo,
          result: message.result,
          cached: message.cached,
        });
        return;
      }

      case 'REJECT': {
        if (message.inReplyTo !== null) {
          this.#settle(message.inReplyTo, {
            outcome: 'REJECTED',
            commandId: message.inReplyTo,
            code: message.code,
            reason: message.reason,
          });
        }
        this.#emit('command.rejected', `${message.code}: ${message.reason}`);
        return;
      }

      case 'PONG': {
        this.#lastView = this.#lastView === null ? null : { ...this.#lastView, state: message.state };
        return;
      }

      default: {
        const _exhaustive: never = message;
      }
    }
  }

  /**
   * Settle the outbox against the device's own record of what it processed,
   * then resend anything genuinely outstanding.
   */
  async #reconcile(processed: readonly string[]): Promise<void> {
    const now = this.#opts.clock.now();
    const stillOutstanding: OutboxEntry[] = [];

    for (const entry of this.#outbox) {
      if (processed.includes(entry.commandId)) {
        // The device did act on it. Report the fact; the authoritative outcome
        // is the device state in HELLO_ACK, which the caller can read.
        this.#emit('command.confirmed-on-resume', entry.commandId);
        this.#settle(entry.commandId, {
          outcome: 'ACKED',
          commandId: entry.commandId,
          result: {
            commandId: entry.commandId,
            status: 'IGNORED_DUPLICATE',
            state: this.#lastView?.state ?? 'IDLE',
            lockdownId: this.#lastView?.lockdownId ?? null,
            restoreDeadline: this.#lastView?.restoreDeadline ?? null,
            detail: 'confirmed applied by the device during the outage',
          },
          cached: true,
        });
        continue;
      }
      if (entry.expiresAt <= now) {
        this.#emit('command.expired-unapplied', entry.commandId);
        this.#settle(entry.commandId, {
          outcome: 'UNCONFIRMED',
          commandId: entry.commandId,
          detail: 'expired while the link was down and the device never processed it',
        });
        continue;
      }
      stillOutstanding.push(entry);
    }

    this.#outbox = stillOutstanding;
    await this.#saveOutbox();
    // Same commandId, fresh seq: safe whether or not it arrived the first time.
    for (const entry of stillOutstanding) this.#trySend(entry);
  }

  #trySend(entry: OutboxEntry): void {
    if (this.#state !== 'ready' || this.#socket === null) return;
    entry.sends += 1;
    this.#seq += 1;
    const payload: CommandPayload = {
      commandId: entry.commandId,
      deviceId: this.#opts.pairing.deviceId,
      type: entry.type,
      lockdownId: entry.lockdownId,
      timestamp: this.#opts.clock.now(),
      expiresAt: entry.expiresAt,
      origin: 'controller',
      seq: this.#seq,
    };
    this.#write({ type: 'COMMAND', command: payload });
  }

  #settle(commandId: string, outcome: SendOutcome): void {
    const pending = this.#pending.get(commandId);
    this.#outbox = this.#outbox.filter((e) => e.commandId !== commandId);
    void this.#saveOutbox();
    if (pending === undefined || pending.settled) return;
    pending.settled = true;
    this.#pending.delete(commandId);
    pending.resolve(outcome);
  }

  #write(message: ControllerMessage): void {
    const socket = this.#socket;
    if (socket === null || socket.destroyed) return;
    const envelope = seal(
      message,
      this.#keys.controllerToDevice,
      this.#opts.pairing.deviceId,
      this.#nonces.next(),
    );
    try {
      socket.write(encodeFrame(envelope));
    } catch {
      socket.destroy();
    }
  }

  #startHeartbeat(): void {
    this.#clearHeartbeat();
    this.#heartbeat = setInterval(() => {
      this.#write({ type: 'PING', at: this.#opts.clock.now() });
    }, HEARTBEAT_INTERVAL_MS);
    this.#heartbeat.unref?.();
  }

  #clearHeartbeat(): void {
    if (this.#heartbeat !== null) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
  }

  #clearTimers(): void {
    this.#clearHeartbeat();
    this.#clearHandshakeTimeout();
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  #emit(event: string, detail?: string): void {
    this.#opts.onEvent?.(event, detail);
  }

  async #loadOutbox(): Promise<void> {
    const raw = await this.#opts.fs.read(OUTBOX_KEY);
    if (raw === null) return;
    try {
      const parsed = JSON.parse(raw) as { seq?: number; entries?: OutboxEntry[] };
      this.#seq = typeof parsed.seq === 'number' ? parsed.seq : 0;
      this.#outbox = Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      this.#seq = 0;
      this.#outbox = [];
    }
  }

  async #saveOutbox(): Promise<void> {
    await this.#opts.fs
      .writeAtomic(OUTBOX_KEY, JSON.stringify({ seq: this.#seq, entries: this.#outbox }))
      .catch(() => undefined);
  }
}
