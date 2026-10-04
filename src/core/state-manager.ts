/**
 * The single writer.
 *
 * This is the only component in the system permitted to modify lockdown state.
 * Controller commands, the 50-second timer, startup recovery and the settings
 * screen all call `submit()`, which funnels everything through one
 * SerialExecutor. No other code path touches the adapter or the store.
 *
 *     Command Queue -> StateManager -> Device Adapter -> Persisted State
 *
 * Invariants enforced here:
 *  - At most one state-changing operation runs at a time (SerialExecutor).
 *  - The snapshot is durably committed before any irreversible change.
 *  - Restoration always writes explicit recorded values, never a toggle.
 *  - Every asynchronous callback proves its `lockdownId` is still active before
 *    it is allowed to change anything.
 *  - The 50-second timer is armed only after LOCKED is durably committed.
 *  - Commands are idempotent and processed exactly once per `commandId`.
 */

import { randomUUID } from 'node:crypto';

import type { ConnectivityController, DataGuard } from '../adapters/port.ts';
import { NOOP_DATA_GUARD } from '../adapters/port.ts';
import { AuditLog } from './audit-log.ts';
import type { Clock, TimerHandle } from './clock.ts';
import { SerialExecutor } from './serial-executor.ts';
import type { Integrity, TransactionStore } from './transaction-store.ts';
import type {
  Capability,
  CapabilityState,
  Command,
  CommandResult,
  CommandStatus,
  LockdownState,
  OpOutcome,
  ResultTable,
  Snapshot,
  StateSnapshotValues,
  TransactionRecord,
} from './types.ts';
import { ALL_CAPABILITIES, NO_RESULTS, snapshotValue, UNKNOWN_STATE } from './types.ts';

export const DEFAULT_HOLD_MS = 50_000;

/**
 * What to do when persisted state cannot be read at all (both slots corrupt).
 *
 * 'lift-restrictions' (default) — clear every restriction this app authored,
 *   read back from the platform, and change nothing else. The owner regains
 *   control of every toggle without this code ever switching a radio on that
 *   was off before. This is the only automatic action that is both safe and
 *   attributable: the restrictions exist *because we created them*, whereas a
 *   radio's power state may reflect the owner's own choice.
 * 'hold' — take no action at all and surface ERROR on the settings screen for
 *   the owner to resolve explicitly via the release valve.
 *
 * Neither policy ever enables a capability that was disabled beforehand.
 */
export type CorruptStatePolicy = 'lift-restrictions' | 'hold';

/** OS-level alarm, so restoration survives the process being killed. */
export interface WakeupScheduler {
  schedule(atEpochMs: number, lockdownId: string): Promise<void>;
  cancel(): Promise<void>;
}

export type StateManagerOptions = {
  readonly deviceId: string;
  readonly adapter: ConnectivityController;
  readonly store: TransactionStore;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly holdMs?: number;
  readonly dataGuard?: DataGuard;
  readonly wakeup?: WakeupScheduler;
  readonly corruptStatePolicy?: CorruptStatePolicy;
  /** Inline retries for a failing restore operation before declaring ERROR. */
  readonly restoreAttempts?: number;
  /**
   * A second, later OS alarm is armed this far past the deadline as a backstop
   * in case the first is coalesced, deferred by Doze, or lost. It is fenced by
   * the same lockdownId, so if the first alarm already restored, the second is
   * ignored as stale.
   */
  readonly redundantAlarmMs?: number;
};

export type EngineStatus = {
  readonly deviceId: string;
  readonly state: LockdownState;
  readonly activeLockdownId: string | null;
  readonly restoreDeadline: number | null;
  readonly msUntilRestore: number | null;
  readonly lastResults: ResultTable | null;
  readonly lastError: string | null;
  readonly generation: number;
  readonly integrity: Integrity | null;
};

export class StateManager {
  readonly #executor = new SerialExecutor();
  readonly #opts: StateManagerOptions;
  readonly #holdMs: number;
  readonly #dataGuard: DataGuard;
  readonly #restoreAttempts: number;
  readonly #corruptPolicy: CorruptStatePolicy;

  #record: TransactionRecord;
  readonly #redundantAlarmMs: number;
  #timer: TimerHandle | null = null;
  #backstopTimer: TimerHandle | null = null;
  #integrity: Integrity | null = null;
  #initialized = false;

  constructor(options: StateManagerOptions) {
    this.#opts = options;
    this.#holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
    this.#dataGuard = options.dataGuard ?? NOOP_DATA_GUARD;
    this.#restoreAttempts = Math.max(1, options.restoreAttempts ?? 2);
    this.#corruptPolicy = options.corruptStatePolicy ?? 'lift-restrictions';
    this.#redundantAlarmMs = Math.max(0, options.redundantAlarmMs ?? 5_000);
    this.#record = options.store.fresh();
  }

  // =======================================================================
  // Public surface. Everything here enters the serial executor.
  // =======================================================================

  /**
   * Load persisted state and complete or roll back whatever was in flight.
   * Must be awaited before commands are accepted.
   */
  async init(): Promise<EngineStatus> {
    return this.#executor.submit(async () => {
      await this.#opts.audit.load();
      const load = await this.#opts.store.load();
      this.#integrity = load.integrity;

      if (load.record === null) {
        this.#record = this.#opts.store.fresh();
        if (load.integrity === 'BOTH_CORRUPT') {
          await this.#log('startup.integrity', 'BOTH_CORRUPT', load.detail ?? null);
          await this.#handleCorruptState();
        } else {
          await this.#log('startup', 'EMPTY', null);
        }
      } else {
        this.#record = load.record;
        await this.#log('startup', load.integrity, load.detail ?? null);
        await this.#recoverFromPersistedState();
      }

      this.#initialized = true;
      return this.#status();
    });
  }

  /** Submit a command. Serialized, idempotent, exactly-once per commandId. */
  async submit(command: Command): Promise<CommandResult> {
    return this.#executor.submit(async () => {
      if (!this.#initialized) {
        return this.#reject(command, 'REJECTED_MALFORMED', 'engine not initialised');
      }

      const malformed = validate(command);
      if (malformed !== null) return this.#reject(command, 'REJECTED_MALFORMED', malformed);

      if (command.deviceId !== this.#opts.deviceId) {
        return this.#reject(command, 'IGNORED_WRONG_DEVICE', 'command addressed to another device');
      }

      // Exactly-once: a retried or duplicated delivery returns the original
      // outcome without re-running any side effect.
      const cached = this.#record.commandLog.find((e) => e.commandId === command.commandId);
      if (cached !== undefined) {
        await this.#log('command.duplicate', 'IGNORED_DUPLICATE', null, command);
        return { ...cached.result, status: 'IGNORED_DUPLICATE' };
      }

      const now = this.#opts.clock.now();
      if (Number.isFinite(command.expiresAt) && command.expiresAt <= now) {
        return this.#remember(command, {
          commandId: command.commandId,
          status: 'IGNORED_EXPIRED',
          state: this.#record.state,
          lockdownId: this.#record.activeLockdownId,
          detail: 'command expired before processing',
        });
      }

      const result = await this.#dispatch(command);
      return this.#remember(command, result);
    });
  }

  /**
   * The owner's release valve, invoked from the settings screen or the offline
   * escape hatch. Serialized like everything else, so it cannot race a
   * lockdown that is mid-flight. It clears authored restrictions and, when a
   * snapshot exists, performs a normal snapshot-accurate restore first so the
   * exact prior values are recovered rather than merely unrestricted.
   */
  async release(): Promise<EngineStatus> {
    return this.#executor.submit(async () => {
      const record = this.#record;
      if (record.snapshot !== null && record.activeLockdownId !== null) {
        const internal: Command = {
          commandId: `release:${record.activeLockdownId}:${this.#opts.clock.now()}`,
          deviceId: this.#opts.deviceId,
          type: 'RECOVER',
          lockdownId: record.activeLockdownId,
          timestamp: this.#opts.clock.now(),
          expiresAt: Number.POSITIVE_INFINITY,
          origin: 'local',
        };
        await this.#performRestore(internal, record.snapshot, record.activeLockdownId, 'release');
      }
      // Belt and braces: whatever the snapshot said, leave no restriction of
      // ours in force.
      const outcome = await this.#releaseAuthored('release');
      if (!outcome.ok) {
        await this.#commit({ state: 'ERROR', lastError: 'release could not clear all restrictions' });
      }
      return this.#status();
    });
  }

  get status(): EngineStatus {
    return this.#status();
  }

  /** Awaits everything currently queued. */
  async drain(): Promise<void> {
    await this.#executor.drain();
  }

  async shutdown(): Promise<void> {
    this.#clearTimer();
    await this.#executor.drain();
    await this.#opts.audit.flush();
    this.#executor.close();
  }

  get executorStats() {
    return this.#executor.stats;
  }

  // =======================================================================
  // Dispatch
  // =======================================================================

  async #dispatch(command: Command): Promise<CommandResult> {
    switch (command.type) {
      case 'STATUS':
        return {
          commandId: command.commandId,
          status: 'STATUS_OK',
          state: this.#record.state,
          lockdownId: this.#record.activeLockdownId,
          results: this.#record.results ?? undefined,
          restoreDeadline: this.#record.restoreDeadline,
        };

      case 'TOGGLE':
        // Resolved inside the lock, so "trigger again" can never race with the
        // state it is deciding against.
        return this.#record.state === 'LOCKED'
          ? this.#restore(command, this.#record.activeLockdownId)
          : this.#activate(command);

      case 'LOCKDOWN':
        return this.#activate(command);

      case 'RESTORE':
        return this.#restore(command, command.lockdownId);

      case 'TIMEOUT':
        return this.#onTimeout(command);

      case 'RECOVER':
        return this.#recoverCommand(command);

      default: {
        const _exhaustive: never = command.type;
        return this.#reject(command, 'REJECTED_MALFORMED', 'unknown command type');
      }
    }
  }

  // =======================================================================
  // LOCKDOWN
  // =======================================================================

  async #activate(command: Command): Promise<CommandResult> {
    // Idempotent: repeated LOCKDOWN is a no-op and does NOT extend the hold.
    if (this.#record.state === 'LOCKED') {
      await this.#log('lockdown.noop', 'ALREADY_LOCKED', null, command);
      return {
        commandId: command.commandId,
        status: 'ALREADY_LOCKED',
        state: 'LOCKED',
        lockdownId: this.#record.activeLockdownId,
        results: this.#record.results ?? undefined,
        restoreDeadline: this.#record.restoreDeadline,
      };
    }

    if (this.#record.state === 'ERROR' || this.#record.state === 'RECOVERY') {
      // Refuse to start a new transaction on top of an unresolved one: doing so
      // would overwrite a snapshot that is still needed.
      await this.#log('lockdown.refused', 'ERROR', 'unresolved prior transaction', command);
      return {
        commandId: command.commandId,
        status: 'LOCKDOWN_FAILED',
        state: this.#record.state,
        lockdownId: this.#record.activeLockdownId,
        detail: 'a previous transaction has not been restored; recover first',
      };
    }

    const report = await this.#opts.adapter.getCapabilities();
    const supported = report.entries
      .filter((e) => e.support === 'SUPPORTED')
      .map((e) => e.capability);

    const results = mutableResults();
    for (const entry of report.entries) {
      if (entry.support !== 'SUPPORTED') {
        results[entry.capability] = { result: 'UNSUPPORTED', changed: false, error: entry.note };
      }
    }

    if (supported.length === 0) {
      // Nothing is permitted on this device. Report it; do not enter LOCKED and
      // do not pretend a lockdown happened.
      await this.#log('lockdown.unsupported', 'LOCKDOWN_FAILED', 'no capability available', command);
      return {
        commandId: command.commandId,
        status: 'LOCKDOWN_FAILED',
        state: 'IDLE',
        lockdownId: null,
        results: results as ResultTable,
        detail: 'no connectivity capability is available to this build on this device',
      };
    }

    const lockdownId = randomUUID();
    const observed = await this.#opts.adapter.captureState();
    const snapshot = buildSnapshot(this.#opts.deviceId, lockdownId, this.#opts.clock.now(), observed, supported);

    // Data integrity: flush our own persistence before connectivity changes, so
    // no write of ours can be truncated by the network disappearing. No other
    // application is signalled or terminated.
    await this.#dataGuard.quiesce();
    await this.#opts.store.checkpoint();

    // The snapshot is durable BEFORE the first irreversible change.
    await this.#commit({
      state: 'PREPARING',
      activeLockdownId: lockdownId,
      snapshot,
      results: results as ResultTable,
      committedAt: null,
      restoreDeadline: null,
      lastError: null,
    });
    await this.#log('lockdown.preparing', 'PREPARING', null, command, lockdownId);

    let modified: Capability[] = [];
    for (const capability of ALL_CAPABILITIES) {
      if (!supported.includes(capability)) continue;

      const outcome = await this.#opts.adapter.lockdown(capability);
      results[capability] = outcome;
      if (outcome.changed) modified = [...modified, capability];

      // Persist after every operation so a crash here leaves an accurate record
      // of exactly what was changed.
      await this.#commit({
        snapshot: { ...snapshot, successfullyModifiedCapabilities: modified },
        results: results as ResultTable,
      });
      await this.#log(
        `lockdown.${capability}`,
        outcome.result,
        outcome.error ?? null,
        command,
        lockdownId,
        describeState(snapshotValue(snapshot, capability)),
        'OFF',
      );
    }

    const failures = supported.filter((c) => results[c].result === 'FAILED');
    if (failures.length > 0) {
      return this.#rollbackPartialLockdown(command, lockdownId, snapshot, results, modified, failures);
    }

    const committedAt = this.#opts.clock.now();
    const restoreDeadline = committedAt + this.#holdMs;
    await this.#commit({
      state: 'LOCKED',
      activeLockdownId: lockdownId,
      snapshot: { ...snapshot, successfullyModifiedCapabilities: modified },
      results: results as ResultTable,
      committedAt,
      restoreDeadline,
      lastError: null,
    });
    await this.#log('lockdown.committed', 'LOCKED', null, command, lockdownId);

    // The timer is armed only now that LOCKED is durable, and it carries the
    // lockdownId as a fence token.
    this.#armRestoreTimer(lockdownId, restoreDeadline);

    return {
      commandId: command.commandId,
      status: 'LOCKED',
      state: 'LOCKED',
      lockdownId,
      results: results as ResultTable,
      restoreDeadline,
    };
  }

  /**
   * Deterministic partial-failure policy: if any capability the OS said it
   * supports could not be locked down, the transaction cannot reach its
   * required state, so every setting this transaction actually modified is
   * restored and the device returns to a known state.
   */
  async #rollbackPartialLockdown(
    command: Command,
    lockdownId: string,
    snapshot: Snapshot,
    results: Record<Capability, OpOutcome>,
    modified: readonly Capability[],
    failures: readonly Capability[],
  ): Promise<CommandResult> {
    const txn: Snapshot = { ...snapshot, successfullyModifiedCapabilities: [...modified] };
    await this.#commit({ state: 'RESTORING', snapshot: txn, results: results as ResultTable });
    await this.#log(
      'lockdown.partial-failure',
      'ROLLBACK',
      `failed: ${failures.join(',')}`,
      command,
      lockdownId,
    );

    const rollback = await this.#applyRestore(txn, command, lockdownId, 'rollback');

    if (rollback.remaining.length === 0) {
      await this.#commit({
        state: 'IDLE',
        activeLockdownId: null,
        snapshot: null,
        results: results as ResultTable,
        committedAt: null,
        restoreDeadline: null,
        generation: this.#record.generation + 1,
        lastError: `lockdown failed: ${failures.join(',')}`,
      });
      await this.#log('lockdown.rolled-back', 'LOCKDOWN_FAILED', null, command, lockdownId);
      return {
        commandId: command.commandId,
        status: 'LOCKDOWN_FAILED',
        state: 'IDLE',
        lockdownId: null,
        results: results as ResultTable,
        detail: `rolled back after failure on: ${failures.join(',')}`,
      };
    }

    // Rollback itself failed. Keep the snapshot and the transaction identity so
    // recovery can retry against the correct values.
    await this.#commit({
      state: 'ERROR',
      activeLockdownId: lockdownId,
      snapshot: { ...txn, successfullyModifiedCapabilities: rollback.remaining },
      results: results as ResultTable,
      lastError: `rollback incomplete: ${rollback.remaining.join(',')}`,
    });
    await this.#log('lockdown.rollback-failed', 'ERROR', rollback.remaining.join(','), command, lockdownId);
    return {
      commandId: command.commandId,
      status: 'RESTORE_FAILED',
      state: 'ERROR',
      lockdownId,
      results: results as ResultTable,
      detail: `rollback incomplete for: ${rollback.remaining.join(',')}`,
    };
  }

  // =======================================================================
  // RESTORE
  // =======================================================================

  async #restore(command: Command, fence: string | null): Promise<CommandResult> {
    if (this.#record.state === 'IDLE') {
      // Idempotent: restoring when nothing is locked changes nothing.
      await this.#log('restore.noop', 'ALREADY_IDLE', null, command);
      return {
        commandId: command.commandId,
        status: 'ALREADY_IDLE',
        state: 'IDLE',
        lockdownId: null,
      };
    }

    const active = this.#record.activeLockdownId;
    // Fencing: an explicit lockdownId must match the live transaction. A stale
    // packet or an old timer can therefore never restore a newer lockdown.
    if (fence !== null && fence !== active) {
      await this.#log('restore.stale', 'IGNORED_STALE', `fence=${fence}`, command, active);
      return {
        commandId: command.commandId,
        status: 'IGNORED_STALE',
        state: this.#record.state,
        lockdownId: active,
        detail: 'lockdownId does not match the active transaction',
      };
    }

    const snapshot = this.#record.snapshot;
    if (snapshot === null || active === null) {
      await this.#commit({
        state: 'IDLE',
        activeLockdownId: null,
        snapshot: null,
        committedAt: null,
        restoreDeadline: null,
        generation: this.#record.generation + 1,
        lastError: 'restore requested with no snapshot on record',
      });
      await this.#log('restore.no-snapshot', 'ALREADY_IDLE', null, command);
      return {
        commandId: command.commandId,
        status: 'ALREADY_IDLE',
        state: 'IDLE',
        lockdownId: null,
        detail: 'no snapshot on record',
      };
    }

    return this.#performRestore(command, snapshot, active, 'restore');
  }

  async #performRestore(
    command: Command,
    snapshot: Snapshot,
    lockdownId: string,
    reason: string,
  ): Promise<CommandResult> {
    this.#clearTimer();
    await this.#opts.wakeup?.cancel().catch(() => undefined);

    await this.#dataGuard.quiesce();
    await this.#opts.store.checkpoint();
    await this.#commit({ state: 'RESTORING', activeLockdownId: lockdownId, snapshot });

    const outcome = await this.#applyRestore(snapshot, command, lockdownId, reason);

    if (outcome.remaining.length === 0) {
      await this.#commit({
        state: 'IDLE',
        activeLockdownId: null,
        snapshot: null,
        results: outcome.results,
        committedAt: null,
        restoreDeadline: null,
        generation: this.#record.generation + 1,
        lastError: null,
      });
      await this.#log(`${reason}.completed`, 'RESTORED', null, command, lockdownId);
      return {
        commandId: command.commandId,
        status: 'RESTORED',
        state: 'IDLE',
        lockdownId,
        results: outcome.results,
      };
    }

    // Snapshot is deliberately preserved: it is the only record of the correct
    // target values and restoration will be retried.
    await this.#commit({
      state: 'ERROR',
      activeLockdownId: lockdownId,
      snapshot: { ...snapshot, successfullyModifiedCapabilities: outcome.remaining },
      results: outcome.results,
      restoreDeadline: null,
      lastError: `restore incomplete: ${outcome.remaining.join(',')}`,
    });
    await this.#log(`${reason}.failed`, 'RESTORE_FAILED', outcome.remaining.join(','), command, lockdownId);
    return {
      commandId: command.commandId,
      status: 'RESTORE_FAILED',
      state: 'ERROR',
      lockdownId,
      results: outcome.results,
      detail: `could not restore: ${outcome.remaining.join(',')}`,
    };
  }

  /**
   * Drive each capability this transaction modified back to its recorded value.
   * Always an explicit assignment from the snapshot — never a toggle — so
   * repeating it cannot move state in the wrong direction.
   */
  async #applyRestore(
    snapshot: Snapshot,
    command: Command,
    lockdownId: string,
    reason: string,
  ): Promise<{ results: ResultTable; remaining: Capability[] }> {
    const results = mutableResults();
    const remaining: Capability[] = [];
    let stillModified = [...snapshot.successfullyModifiedCapabilities];

    for (const capability of snapshot.successfullyModifiedCapabilities) {
      const desired = snapshotValue(snapshot, capability);
      let outcome: OpOutcome = { result: 'NOT_ATTEMPTED', changed: false };

      for (let attempt = 1; attempt <= this.#restoreAttempts; attempt++) {
        outcome = await this.#opts.adapter.restore(capability, desired);
        if (outcome.result !== 'FAILED') break;
        await this.#log(
          `${reason}.${capability}.retry`,
          'FAILED',
          `attempt ${attempt}`,
          command,
          lockdownId,
        );
      }

      results[capability] = outcome;
      if (outcome.result === 'FAILED') {
        remaining.push(capability);
      } else {
        // Successfully restored: drop it from the outstanding set and persist,
        // so a crash mid-restore does not re-restore what is already correct.
        stillModified = stillModified.filter((c) => c !== capability);
        await this.#commit({
          snapshot: { ...snapshot, successfullyModifiedCapabilities: stillModified },
          results: results as ResultTable,
        });
      }

      await this.#log(
        `${reason}.${capability}`,
        outcome.result,
        outcome.error ?? null,
        command,
        lockdownId,
        'OFF',
        describeState(desired),
      );
    }

    return { results: results as ResultTable, remaining };
  }

  // =======================================================================
  // Timeout
  // =======================================================================

  #armRestoreTimer(lockdownId: string, deadline: number): void {
    this.#clearTimer();

    const fire = (tag: string, at: number) => () => {
      // The callback never touches state. It submits a fenced command, which is
      // serialized with everything else and ignored if it is no longer current.
      void this.submit({
        commandId: `timeout:${lockdownId}:${tag}:${at}`,
        deviceId: this.#opts.deviceId,
        type: 'TIMEOUT',
        lockdownId,
        timestamp: this.#opts.clock.now(),
        expiresAt: Number.POSITIVE_INFINITY,
        origin: 'timer',
      }).catch(() => undefined);
    };

    const delay = Math.max(0, deadline - this.#opts.clock.now());
    this.#timer = this.#opts.clock.setTimer(delay, () => {
      this.#timer = null;
      fire('primary', deadline)();
    });

    // Layer 2: a second in-process timer slightly later, in case the first was
    // deferred. Fenced by the same lockdownId, so it is a no-op once restored.
    if (this.#redundantAlarmMs > 0) {
      this.#backstopTimer = this.#opts.clock.setTimer(delay + this.#redundantAlarmMs, () => {
        this.#backstopTimer = null;
        fire('backstop', deadline + this.#redundantAlarmMs)();
      });
    }

    // Layer 3: an OS alarm, so restoration still happens if this process is
    // killed or the device sleeps before either in-memory timer fires.
    void this.#opts.wakeup?.schedule(deadline, lockdownId).catch(() => undefined);
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      this.#opts.clock.clearTimer(this.#timer);
      this.#timer = null;
    }
    if (this.#backstopTimer !== null) {
      this.#opts.clock.clearTimer(this.#backstopTimer);
      this.#backstopTimer = null;
    }
  }

  async #onTimeout(command: Command): Promise<CommandResult> {
    const active = this.#record.activeLockdownId;

    // The decisive fence check. Lockdown A -> Lockdown B -> Timeout A must not
    // restore B's state. A timeout arriving with no active transaction at all
    // is stale by definition, which also narrows `active` to non-null below.
    if (active === null || command.lockdownId !== active || this.#record.state !== 'LOCKED') {
      await this.#log(
        'timeout.stale',
        'IGNORED_STALE',
        `fence=${command.lockdownId ?? 'null'} active=${active ?? 'null'} state=${this.#record.state}`,
        command,
        active,
      );
      return {
        commandId: command.commandId,
        status: 'IGNORED_STALE',
        state: this.#record.state,
        lockdownId: active,
        detail: 'timeout does not belong to the active transaction',
      };
    }

    const deadline = this.#record.restoreDeadline;
    if (deadline !== null && this.#opts.clock.now() < deadline) {
      // Fired early (clock adjustment, coalesced alarm). Re-arm, change nothing.
      this.#armRestoreTimer(active, deadline);
      await this.#log('timeout.early', 'IGNORED_STALE', 'not yet due', command, active);
      return {
        commandId: command.commandId,
        status: 'IGNORED_STALE',
        state: 'LOCKED',
        lockdownId: active,
        restoreDeadline: deadline,
        detail: 'not yet due; timer re-armed',
      };
    }

    const snapshot = this.#record.snapshot;
    if (snapshot === null) {
      await this.#commit({ state: 'ERROR', lastError: 'LOCKED with no snapshot' });
      return {
        commandId: command.commandId,
        status: 'RESTORE_FAILED',
        state: 'ERROR',
        lockdownId: active,
        detail: 'no snapshot available for the active transaction',
      };
    }

    return this.#performRestore(command, snapshot, active, 'timeout');
  }

  // =======================================================================
  // Recovery
  // =======================================================================

  async #recoverCommand(command: Command): Promise<CommandResult> {
    if (command.lockdownId !== this.#record.activeLockdownId) {
      return {
        commandId: command.commandId,
        status: 'IGNORED_STALE',
        state: this.#record.state,
        lockdownId: this.#record.activeLockdownId,
        detail: 'recover does not match the active transaction',
      };
    }
    await this.#recoverFromPersistedState();
    return {
      commandId: command.commandId,
      status: this.#record.state === 'IDLE' ? 'RECOVERED' : 'RESTORE_FAILED',
      state: this.#record.state,
      lockdownId: this.#record.activeLockdownId,
      results: this.#record.results ?? undefined,
    };
  }

  /**
   * Decide, from durable state alone, whether restoration is required — and do
   * it. Called on startup (after reboot, process kill or app suspension) and by
   * the RECOVER command. Never assumes "restarted means fine".
   */
  async #recoverFromPersistedState(): Promise<void> {
    const record = this.#record;
    const internal: Command = {
      commandId: `recovery:${record.generation}:${this.#opts.clock.now()}`,
      deviceId: this.#opts.deviceId,
      type: 'RECOVER',
      lockdownId: record.activeLockdownId,
      timestamp: this.#opts.clock.now(),
      expiresAt: Number.POSITIVE_INFINITY,
      origin: 'recovery',
    };

    switch (record.state) {
      case 'IDLE':
        this.#clearTimer();
        await this.#opts.wakeup?.cancel().catch(() => undefined);
        return;

      case 'PREPARING': {
        // Crashed mid-lockdown. The snapshot was committed before the first
        // change, and successfullyModifiedCapabilities is accurate, so roll the
        // transaction back to a known state.
        if (record.snapshot === null || record.activeLockdownId === null) {
          await this.#commit({
            state: 'ERROR',
            lastError: 'PREPARING without a snapshot',
          });
          return;
        }
        await this.#log('recovery.preparing', 'ROLLBACK', null, internal, record.activeLockdownId);
        await this.#performRestore(internal, record.snapshot, record.activeLockdownId, 'recovery');
        return;
      }

      case 'LOCKED': {
        if (record.snapshot === null || record.activeLockdownId === null) {
          await this.#commit({ state: 'ERROR', lastError: 'LOCKED without a snapshot' });
          return;
        }
        const deadline = record.restoreDeadline ?? 0;
        const now = this.#opts.clock.now();
        if (now >= deadline) {
          // The hold elapsed while we were not running. Restore now.
          await this.#log('recovery.expired', 'RESTORE', null, internal, record.activeLockdownId);
          await this.#performRestore(internal, record.snapshot, record.activeLockdownId, 'recovery');
        } else {
          // Still inside the hold: re-arm for the remaining time only.
          await this.#log('recovery.rearm', 'LOCKED', `${deadline - now}ms left`, internal, record.activeLockdownId);
          this.#armRestoreTimer(record.activeLockdownId, deadline);
        }
        return;
      }

      case 'RESTORING':
      case 'ERROR':
      case 'RECOVERY': {
        if (record.snapshot === null || record.activeLockdownId === null) {
          await this.#commit({
            state: 'IDLE',
            activeLockdownId: null,
            snapshot: null,
            committedAt: null,
            restoreDeadline: null,
            generation: record.generation + 1,
          });
          return;
        }
        await this.#commit({ state: 'RECOVERY' });
        await this.#log('recovery.resume', record.state, null, internal, record.activeLockdownId);
        await this.#performRestore(internal, record.snapshot, record.activeLockdownId, 'recovery');
        return;
      }

      default: {
        const _exhaustive: never = record.state;
        return;
      }
    }
  }

  /** Both persisted slots failed validation: apply the configured policy. */
  async #handleCorruptState(): Promise<void> {
    if (this.#corruptPolicy === 'hold') {
      await this.#commit({
        state: 'ERROR',
        lastError: 'persisted state unreadable; holding without connectivity changes',
      });
      await this.#log('corrupt.hold', 'ERROR', 'no connectivity action taken', null);
      return;
    }

    // lift-restrictions: clear what we authored, and nothing else. No radio is
    // switched on, so a capability the owner had turned off stays off.
    const outcome = await this.#releaseAuthored('corrupt');
    await this.#commit({
      state: outcome.ok ? 'IDLE' : 'ERROR',
      activeLockdownId: null,
      snapshot: null,
      results: outcome.results,
      committedAt: null,
      restoreDeadline: null,
      generation: this.#record.generation + 1,
      lastError: outcome.ok
        ? 'persisted state was unreadable; authored restrictions were lifted'
        : 'persisted state was unreadable and some restrictions could not be lifted',
    });
  }

  /**
   * Clear every restriction this app authored and nothing else. Shared by the
   * corrupt-state path, the owner's settings screen and the offline escape
   * hatch, so there is exactly one implementation of "let me out".
   */
  async #releaseAuthored(reason: string): Promise<{ ok: boolean; results: ResultTable }> {
    const results = mutableResults();
    let ok = true;
    let cleared: Partial<Record<Capability, OpOutcome>> = {};
    try {
      cleared = await this.#opts.adapter.clearAuthoredRestrictions();
    } catch (err) {
      ok = false;
      await this.#log(
        `${reason}.release.error`,
        'FAILED',
        err instanceof Error ? err.message : 'unknown error',
        null,
      );
    }
    for (const capability of ALL_CAPABILITIES) {
      const outcome = cleared[capability];
      if (outcome === undefined) continue;
      results[capability] = outcome;
      if (outcome.result === 'FAILED') ok = false;
      await this.#log(
        `${reason}.release.${capability}`,
        outcome.result,
        outcome.error ?? null,
        null,
        null,
        'RESTRICTED',
        'UNRESTRICTED',
      );
    }
    return { ok, results: results as ResultTable };
  }

  // =======================================================================
  // Internals
  // =======================================================================

  async #commit(patch: Partial<Omit<TransactionRecord, 'schemaVersion' | 'seq' | 'deviceId'>>): Promise<void> {
    const next: TransactionRecord = { ...this.#record, ...patch };
    // The store writes to the alternate slot, so if this throws (power loss)
    // the previously committed record — and its snapshot — remain readable.
    this.#record = await this.#opts.store.commit(next);
  }

  #remember(command: Command, result: CommandResult): CommandResult {
    // Fire-and-forget: the exactly-once cache is best-effort durability on top
    // of the authoritative state, and must not delay the command's reply.
    void this.#commit({
      commandLog: [...this.#record.commandLog, { commandId: command.commandId, result }],
    }).catch(() => undefined);
    return result;
  }

  async #reject(command: Command, status: CommandStatus, detail: string): Promise<CommandResult> {
    await this.#log('command.rejected', status, detail, command);
    return {
      commandId: command.commandId,
      status,
      state: this.#record.state,
      lockdownId: this.#record.activeLockdownId,
      detail,
    };
  }

  async #log(
    operation: string,
    result: string,
    error: string | null,
    command?: Command | null,
    lockdownId?: string | null,
    previousState?: string | null,
    requestedState?: string | null,
  ): Promise<void> {
    await this.#opts.audit.append({
      timestamp: this.#opts.clock.now(),
      deviceId: this.#opts.deviceId,
      lockdownId: lockdownId ?? command?.lockdownId ?? this.#record.activeLockdownId,
      commandId: command?.commandId ?? null,
      operation,
      previousState: previousState ?? null,
      requestedState: requestedState ?? null,
      result,
      error,
    });
  }

  #status(): EngineStatus {
    const deadline = this.#record.restoreDeadline;
    return {
      deviceId: this.#opts.deviceId,
      state: this.#record.state,
      activeLockdownId: this.#record.activeLockdownId,
      restoreDeadline: deadline,
      msUntilRestore: deadline === null ? null : Math.max(0, deadline - this.#opts.clock.now()),
      lastResults: this.#record.results,
      lastError: this.#record.lastError,
      generation: this.#record.generation,
      integrity: this.#integrity,
    };
  }
}

// =========================================================================
// Helpers
// =========================================================================

function mutableResults(): Record<Capability, OpOutcome> {
  return { ...NO_RESULTS };
}

function buildSnapshot(
  deviceId: string,
  lockdownId: string,
  timestamp: number,
  observed: StateSnapshotValues,
  supported: readonly Capability[],
): Snapshot {
  return {
    deviceId,
    lockdownId,
    timestamp,
    wifiState: observed.wifi ?? UNKNOWN_STATE,
    cellularState: observed.cellular ?? UNKNOWN_STATE,
    bluetoothState: observed.bluetooth ?? UNKNOWN_STATE,
    nfcState: observed.nfc ?? UNKNOWN_STATE,
    nearbySharingState: observed.nearbySharing ?? UNKNOWN_STATE,
    hotspotState: observed.hotspot ?? UNKNOWN_STATE,
    supportedCapabilities: [...supported],
    successfullyModifiedCapabilities: [],
  };
}

function describeState(state: CapabilityState): string {
  return state.enabled;
}

function validate(command: Command): string | null {
  if (typeof command.commandId !== 'string' || command.commandId.length === 0) {
    return 'missing commandId';
  }
  if (typeof command.deviceId !== 'string' || command.deviceId.length === 0) {
    return 'missing deviceId';
  }
  if (typeof command.timestamp !== 'number' || !Number.isFinite(command.timestamp)) {
    return 'missing timestamp';
  }
  if (typeof command.expiresAt !== 'number') return 'missing expiration';
  const known = ['LOCKDOWN', 'RESTORE', 'TOGGLE', 'TIMEOUT', 'RECOVER', 'STATUS'];
  if (!known.includes(command.type)) return 'unknown command type';
  if ((command.type === 'TIMEOUT' || command.type === 'RECOVER') && command.lockdownId === null) {
    // A callback with no fence token could restore a transaction it does not
    // own, so it is rejected outright.
    return `${command.type} requires a lockdownId`;
  }
  return null;
}
