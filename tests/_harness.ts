/** Shared test harness: builds an engine over an in-memory device and clock. */

import { AuditLog } from '../src/core/audit-log.ts';
import { VirtualClock, drainMicrotasks } from '../src/core/clock.ts';
import { MemoryAtomicFs } from '../src/core/fs-port.ts';
import { TransactionStore } from '../src/core/transaction-store.ts';
import type { CorruptStatePolicy, StateManagerOptions, WakeupScheduler } from '../src/core/state-manager.ts';
import { StateManager } from '../src/core/state-manager.ts';
import type { Capability, Command, CommandType } from '../src/core/types.ts';
import type { SimulatedAdapterOptions } from '../src/adapters/simulated.ts';
import { SimulatedConnectivityController } from '../src/adapters/simulated.ts';

export const DEVICE = 'phone-a';

/** Records OS alarms so tests can assert the durable backstop was armed. */
export class RecordingWakeup implements WakeupScheduler {
  readonly scheduled: { atEpochMs: number; lockdownId: string }[] = [];
  cancels = 0;
  async schedule(atEpochMs: number, lockdownId: string): Promise<void> {
    this.scheduled.push({ atEpochMs, lockdownId });
  }
  async cancel(): Promise<void> {
    this.cancels++;
  }
}

export type Harness = {
  readonly fs: MemoryAtomicFs;
  readonly clock: VirtualClock;
  readonly adapter: SimulatedConnectivityController;
  readonly audit: AuditLog;
  readonly store: TransactionStore;
  readonly engine: StateManager;
  readonly wakeup: RecordingWakeup;
  readonly deviceId: string;
};

export type HarnessOptions = {
  readonly deviceId?: string;
  readonly holdMs?: number;
  readonly adapter?: SimulatedAdapterOptions;
  readonly fs?: MemoryAtomicFs;
  readonly clock?: VirtualClock;
  readonly device?: SimulatedConnectivityController;
  readonly corruptStatePolicy?: CorruptStatePolicy;
  readonly restoreAttempts?: number;
  readonly redundantAlarmMs?: number;
};

export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const deviceId = options.deviceId ?? DEVICE;
  const fs = options.fs ?? new MemoryAtomicFs();
  const clock = options.clock ?? new VirtualClock();
  const adapter = options.device ?? new SimulatedConnectivityController(options.adapter);
  const audit = new AuditLog(fs, 200);
  const store = new TransactionStore(fs, deviceId);
  const wakeup = new RecordingWakeup();

  const opts: StateManagerOptions = {
    deviceId,
    adapter,
    store,
    audit,
    clock,
    wakeup,
    holdMs: options.holdMs ?? 50_000,
    corruptStatePolicy: options.corruptStatePolicy ?? 'lift-restrictions',
    restoreAttempts: options.restoreAttempts ?? 1,
    // Off by default so tests assert one timer firing; enabled where relevant.
    redundantAlarmMs: options.redundantAlarmMs ?? 0,
  };
  const engine = new StateManager(opts);
  await engine.init();
  return { fs, clock, adapter, audit, store, engine, wakeup, deviceId };
}

let seq = 0;

/** Build a well-formed command. */
export function cmd(
  type: CommandType,
  overrides: Partial<Command> & { clock?: VirtualClock } = {},
): Command {
  const now = overrides.clock?.now() ?? overrides.timestamp ?? 1_700_000_000_000;
  return {
    commandId: overrides.commandId ?? `c${++seq}`,
    deviceId: overrides.deviceId ?? DEVICE,
    type,
    lockdownId: overrides.lockdownId ?? null,
    timestamp: now,
    expiresAt: overrides.expiresAt ?? now + 15_000,
    origin: overrides.origin ?? 'controller',
  };
}

export { drainMicrotasks };

export const EVERY: readonly Capability[] = [
  'wifi',
  'cellular',
  'bluetooth',
  'nfc',
  'nearbySharing',
  'hotspot',
];

/**
 * Rebuild the engine over the SAME persisted filesystem and the SAME device.
 *
 * This is how a reboot or a process kill is modelled. The device adapter is
 * reused deliberately: on a real phone, OS-level restrictions survive a
 * restart, so the connectivity state a recovering process observes is whatever
 * the previous one left behind.
 */
export async function restart(
  h: Harness,
  options: { killTimers?: boolean; elapseMs?: number; corruptStatePolicy?: CorruptStatePolicy; restoreAttempts?: number } = {},
): Promise<Harness> {
  if (options.killTimers !== false) h.clock.dropAllTimers();
  if (options.elapseMs !== undefined) h.clock.jump(options.elapseMs);
  return makeHarness({
    deviceId: h.deviceId,
    fs: h.fs,
    clock: h.clock,
    device: h.adapter,
    ...(options.corruptStatePolicy === undefined ? {} : { corruptStatePolicy: options.corruptStatePolicy }),
    ...(options.restoreAttempts === undefined ? {} : { restoreAttempts: options.restoreAttempts }),
  });
}
