/**
 * Platform abstraction.
 *
 * The specification sketches `{ getCapabilities, captureState, lockdown,
 * restore }`. `lockdown` and `restore` are defined here per *capability* rather
 * than as one bulk call, for two reasons that matter to the stated priorities:
 *
 *  1. Crash safety. The engine persists `successfullyModifiedCapabilities`
 *     after each individual success, so a power loss halfway through leaves an
 *     accurate record of exactly what was changed. A bulk call cannot offer that.
 *  2. Deterministic partial-failure recovery. Rollback must touch exactly the
 *     capabilities this transaction actually modified — no more, no less.
 *
 * Bulk orchestration lives in the engine (`applyLockdown` / `applyRestore`), so
 * adapters stay small and contain no policy.
 */

import type {
  Capability,
  CapabilityReport,
  CapabilityState,
  OpOutcome,
  Platform,
  StateSnapshotValues,
} from '../core/types.ts';

export interface ConnectivityController {
  readonly platform: Platform;

  /**
   * What this build may actually do on this device, right now. Determined from
   * the OS at runtime (API level, management role, present hardware) — never
   * from an assumption. Capabilities the OS does not expose to this process are
   * reported UNSUPPORTED_BY_OS / REQUIRES_PRIVILEGE and are never attempted.
   */
  getCapabilities(): Promise<CapabilityReport>;

  /** Read current connectivity state. Returns no configuration content, by type. */
  captureState(): Promise<StateSnapshotValues>;

  /** Apply the lockdown restriction for one capability. */
  lockdown(capability: Capability): Promise<OpOutcome>;

  /**
   * Drive one capability to an explicit target state taken from the snapshot.
   * Never a toggle: the desired value is always passed in.
   */
  restore(capability: Capability, desired: CapabilityState): Promise<OpOutcome>;

  /**
   * Last-resort release valve.
   *
   * Clears every *restriction this application itself authored* — the policy
   * flags it set during a lockdown — and nothing else. It deliberately does not
   * change any radio's power state, because a radio that is off may have been
   * off because the owner wanted it off.
   *
   * This is what runs when persisted state is unreadable, and what the owner's
   * settings screen and the offline escape hatch invoke. It is attributable
   * rather than speculative: on Android the authored restrictions are read back
   * from UserManager, so clearing them is a fact, not a guess.
   */
  clearAuthoredRestrictions(): Promise<Partial<Record<Capability, OpOutcome>>>;
}

/**
 * Hook for application-owned persistence. Called once, before any connectivity
 * change, so our own writes are flushed and cannot be truncated by the network
 * going away. It must never terminate or signal other applications.
 */
export interface DataGuard {
  quiesce(): Promise<void>;
}

export const NOOP_DATA_GUARD: DataGuard = { async quiesce() {} };

export function unsupported(reason: string): OpOutcome {
  return { result: 'UNSUPPORTED', changed: false, error: reason };
}

export function failed(reason: string): OpOutcome {
  return { result: 'FAILED', changed: false, error: reason };
}

export function succeeded(changed: boolean): OpOutcome {
  return { result: changed ? 'SUCCESS' : 'NO_CHANGE_NEEDED', changed };
}
