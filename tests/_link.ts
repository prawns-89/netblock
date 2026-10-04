/** Helpers for exercising the real wire protocol over real sockets. */

import * as net from 'node:net';
import { randomUUID } from 'node:crypto';

import { AuditLog } from '../src/core/audit-log.ts';
import { SystemClock } from '../src/core/clock.ts';
import { MemoryAtomicFs } from '../src/core/fs-port.ts';
import { StateManager } from '../src/core/state-manager.ts';
import { TransactionStore } from '../src/core/transaction-store.ts';
import { SimulatedConnectivityController } from '../src/adapters/simulated.ts';
import type { SimulatedAdapterOptions } from '../src/adapters/simulated.ts';
import { DeviceServer } from '../src/device/server.ts';
import type { CommandPayload } from '../src/protocol/envelope.ts';
import { NonceSource, open, seal } from '../src/protocol/envelope.ts';
import { encodeFrame, FrameDecoder } from '../src/protocol/framing.ts';
import type { PairingRecord } from '../src/protocol/pairing.ts';
import { deriveKeys, generatePairingSecret, makePairingRecord, secretOf } from '../src/protocol/pairing.ts';
import { PairingStore } from '../src/protocol/pairing-store.ts';
import { ReplayGuard } from '../src/protocol/replay-guard.ts';
import type { ControllerMessage, DeviceMessage } from '../src/protocol/session.ts';

export type Link = {
  readonly deviceId: string;
  readonly record: PairingRecord;
  readonly port: number;
  readonly server: DeviceServer;
  readonly engine: StateManager;
  readonly adapter: SimulatedConnectivityController;
  readonly fs: MemoryAtomicFs;
  readonly close: () => Promise<void>;
};

export async function makeLink(
  options: { holdMs?: number; adapter?: SimulatedAdapterOptions; label?: string } = {},
): Promise<Link> {
  const deviceId = randomUUID();
  const secret = generatePairingSecret();
  const record = makePairingRecord(deviceId, options.label ?? 'phone', secret, Date.now());

  const fs = new MemoryAtomicFs();
  const clock = new SystemClock();
  const adapter = new SimulatedConnectivityController(options.adapter);
  const audit = new AuditLog(fs, 300);
  const engine = new StateManager({
    deviceId,
    adapter,
    store: new TransactionStore(fs, deviceId),
    audit,
    clock,
    holdMs: options.holdMs ?? 50_000,
    redundantAlarmMs: 0,
  });
  await engine.init();

  const pairings = new PairingStore(fs);
  await pairings.load();
  await pairings.upsert(record);
  const replay = new ReplayGuard(fs);
  await replay.load();

  const server = new DeviceServer({
    deviceId,
    engine,
    pairings,
    replay,
    audit,
    clock,
    port: 0,
    host: '127.0.0.1',
  });
  const bound = await server.listen();

  return {
    deviceId,
    record,
    port: bound.port,
    server,
    engine,
    adapter,
    fs,
    close: async () => {
      await server.close();
      await engine.shutdown();
    },
  };
}

/**
 * A controller that speaks the wire format directly, so tests can send exactly
 * the bytes they want: duplicates, stale sequence numbers, expired commands,
 * frames signed with the wrong key.
 */
export class RawClient {
  readonly #record: PairingRecord;
  readonly #keys: ReturnType<typeof deriveKeys>;
  readonly #nonces = new NonceSource(0n);
  #socket: net.Socket | null = null;
  #decoder = new FrameDecoder();
  readonly received: DeviceMessage[] = [];
  #seq = 0;

  constructor(record: PairingRecord, overrideSecret?: Buffer) {
    this.#record = record;
    this.#keys = deriveKeys(overrideSecret ?? secretOf(record), record.deviceId);
  }

  async connect(port: number): Promise<void> {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    this.#socket = socket;
    this.#decoder = new FrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      const { frames } = this.#decoder.push(chunk);
      for (const frame of frames) {
        const opened = open<DeviceMessage>(frame, this.#keys.deviceToController, this.#record.deviceId);
        if (opened.ok) this.received.push(opened.value);
      }
    });
    socket.on('error', () => undefined);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
  }

  get closed(): boolean {
    return this.#socket === null || this.#socket.destroyed;
  }

  write(message: ControllerMessage): void {
    const socket = this.#socket;
    if (socket === null || socket.destroyed) return;
    const envelope = seal(message, this.#keys.controllerToDevice, this.#record.deviceId, this.#nonces.next());
    socket.write(encodeFrame(envelope));
  }

  /** Write pre-encoded bytes verbatim, for malformed-frame tests. */
  writeRaw(buffer: Buffer): void {
    this.#socket?.write(buffer);
  }

  async hello(): Promise<void> {
    this.write({ type: 'HELLO', sessionId: randomUUID(), lastSentSeq: 0, sentAt: Date.now() });
    await this.waitFor((m) => m.type === 'HELLO_ACK');
  }

  nextSeq(): number {
    return ++this.#seq;
  }

  command(payload: Partial<CommandPayload> & { type: CommandPayload['type'] }): CommandPayload {
    const now = Date.now();
    return {
      commandId: payload.commandId ?? randomUUID(),
      deviceId: this.#record.deviceId,
      type: payload.type,
      lockdownId: payload.lockdownId ?? null,
      timestamp: payload.timestamp ?? now,
      expiresAt: payload.expiresAt ?? now + 15_000,
      origin: 'controller',
      seq: payload.seq ?? this.nextSeq(),
    };
  }

  send(payload: CommandPayload): void {
    this.write({ type: 'COMMAND', command: payload });
  }

  async waitFor(predicate: (m: DeviceMessage) => boolean, timeoutMs = 3_000): Promise<DeviceMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.received.find(predicate);
      if (hit !== undefined) return hit;
      if (Date.now() > deadline) throw new Error('timed out waiting for a device message');
      if (this.closed) throw new Error('socket closed while waiting');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async waitForClose(timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error('socket did not close');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  close(): void {
    this.#socket?.destroy();
    this.#socket = null;
  }
}

/**
 * A TCP relay the test can cut or silence, to model the link dying exactly when
 * a lockdown disables the Wi-Fi it is travelling over.
 */
export class CuttableProxy {
  #server: net.Server | null = null;
  #pairs = new Set<net.Socket>();
  #blockFromDevice = false;
  readonly #targetPort: number;

  constructor(targetPort: number) {
    this.#targetPort = targetPort;
  }

  async listen(): Promise<number> {
    const server = net.createServer((client) => {
      const upstream = net.createConnection({ host: '127.0.0.1', port: this.#targetPort });
      this.#pairs.add(client);
      this.#pairs.add(upstream);
      client.on('data', (d: Buffer) => upstream.write(d));
      upstream.on('data', (d: Buffer) => {
        // Commands still reach the phone; replies are swallowed.
        if (!this.#blockFromDevice) client.write(d);
      });
      const bothDown = () => {
        client.destroy();
        upstream.destroy();
        this.#pairs.delete(client);
        this.#pairs.delete(upstream);
      };
      client.on('close', bothDown);
      upstream.on('close', bothDown);
      client.on('error', bothDown);
      upstream.on('error', bothDown);
    });
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    return typeof addr === 'object' && addr !== null ? addr.port : 0;
  }

  /** Stop relaying device replies. The phone still receives commands. */
  silenceReplies(on: boolean): void {
    this.#blockFromDevice = on;
  }

  /** Drop every live connection, as losing Wi-Fi would. */
  cut(): void {
    for (const s of [...this.#pairs]) s.destroy();
    this.#pairs.clear();
  }

  async close(): Promise<void> {
    this.cut();
    const server = this.#server;
    this.#server = null;
    if (server !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
