/**
 * Deterministic in-process device. Backs the automated test suite and the
 * desktop development loop. It models the semantics a real adapter must honour:
 * explicit target states, NO_CHANGE_NEEDED when already correct, and refusal to
 * touch anything the capability report marks as unavailable.
 */

import type {
  Capability,
  CapabilityReport,
  CapabilityState,
  CapabilitySupport,
  OpOutcome,
  Platform,
  StateSnapshotValues,
  SupportLevel,
} from '../core/types.ts';
import { ALL_CAPABILITIES } from '../core/types.ts';
import type { ConnectivityController } from './port.ts';
import { failed, succeeded, unsupported } from './port.ts';

export type SimulatedDeviceState = { [K in Capability]: CapabilityState };

export type SimFault = {
  readonly capability: Capability;
  readonly phase: 'lockdown' | 'restore';
  /** How many consecutive attempts fail. Infinity for a permanent failure. */
  remaining: number;
  readonly message: string;
};

export const DEFAULT_SIM_STATE: SimulatedDeviceState = {
  wifi: { enabled: 'ON', autoJoinAllowed: true },
  cellular: { enabled: 'ON' },
  bluetooth: { enabled: 'ON', discoverable: true },
  nfc: { enabled: 'ON' },
  nearbySharing: { enabled: 'ON', discoverable: true },
  hotspot: { enabled: 'OFF', tetheringActive: false },
};

export type SimulatedAdapterOptions = {
  readonly support?: Partial<Record<Capability, SupportLevel>>;
  readonly initial?: Partial<SimulatedDeviceState>;
  readonly platform?: Platform;
};

export class SimulatedConnectivityController implements ConnectivityController {
  readonly platform: Platform;
  readonly #support: Record<Capability, SupportLevel>;
  #state: SimulatedDeviceState;
  #faults: SimFault[] = [];
  /** Restrictions this adapter itself applied, mirroring UserManager read-back. */
  #authored = new Set<Capability>();
  /** Ordered record of every operation, so tests can assert call counts. */
  readonly calls: { capability: Capability; phase: string; at: number }[] = [];

  constructor(options: SimulatedAdapterOptions = {}) {
    this.platform = options.platform ?? 'simulated';
    this.#support = Object.fromEntries(
      ALL_CAPABILITIES.map((c) => [c, options.support?.[c] ?? 'SUPPORTED']),
    ) as Record<Capability, SupportLevel>;
    this.#state = structuredClone({ ...DEFAULT_SIM_STATE, ...(options.initial ?? {}) });
  }

  // --- test controls ------------------------------------------------------

  get deviceState(): SimulatedDeviceState {
    return structuredClone(this.#state);
  }

  setDeviceState(patch: Partial<SimulatedDeviceState>): void {
    this.#state = structuredClone({ ...this.#state, ...patch });
  }

  injectFault(fault: Omit<SimFault, 'remaining'> & { remaining?: number }): void {
    this.#faults.push({ ...fault, remaining: fault.remaining ?? Number.POSITIVE_INFINITY });
  }

  clearFaults(): void {
    this.#faults = [];
  }

  #takeFault(capability: Capability, phase: 'lockdown' | 'restore'): string | null {
    const f = this.#faults.find(
      (x) => x.capability === capability && x.phase === phase && x.remaining > 0,
    );
    if (f === undefined) return null;
    f.remaining -= 1;
    return f.message;
  }

  // --- ConnectivityController -------------------------------------------

  async getCapabilities(): Promise<CapabilityReport> {
    const entries: CapabilitySupport[] = ALL_CAPABILITIES.map((capability) => ({
      capability,
      support: this.#support[capability],
      mechanism: this.#support[capability] === 'SUPPORTED' ? 'simulated' : 'none',
      note:
        this.#support[capability] === 'SUPPORTED'
          ? 'simulated device'
          : 'simulated as unavailable on this device',
    }));
    return { platform: this.platform, entries };
  }

  async captureState(): Promise<StateSnapshotValues> {
    const out: Record<string, CapabilityState> = {};
    for (const c of ALL_CAPABILITIES) {
      // An unavailable capability is reported UNKNOWN rather than guessed.
      out[c] = this.#support[c] === 'SUPPORTED' ? structuredClone(this.#state[c]) : { enabled: 'UNKNOWN' };
    }
    return out as StateSnapshotValues;
  }

  async lockdown(capability: Capability): Promise<OpOutcome> {
    this.calls.push({ capability, phase: 'lockdown', at: this.calls.length });
    if (this.#support[capability] !== 'SUPPORTED') {
      return unsupported(`${capability} not available to this build`);
    }
    const fault = this.#takeFault(capability, 'lockdown');
    if (fault !== null) return failed(fault);

    const before = this.#state[capability];
    const target = lockedTarget(capability, before);
    if (equalState(before, target)) return succeeded(false);
    this.#state[capability] = target;
    this.#authored.add(capability);
    return succeeded(true);
  }

  async restore(capability: Capability, desired: CapabilityState): Promise<OpOutcome> {
    this.calls.push({ capability, phase: 'restore', at: this.calls.length });
    if (this.#support[capability] !== 'SUPPORTED') {
      return unsupported(`${capability} not available to this build`);
    }
    const fault = this.#takeFault(capability, 'restore');
    if (fault !== null) return failed(fault);

    if (desired.enabled === 'UNKNOWN') {
      // Nothing trustworthy to restore to: refuse rather than guess.
      return unsupported('no trustworthy prior value recorded');
    }
    const before = this.#state[capability];
    this.#authored.delete(capability);
    if (equalState(before, desired)) return succeeded(false);
    this.#state[capability] = structuredClone(desired);
    return succeeded(true);
  }

  async clearAuthoredRestrictions(): Promise<Partial<Record<Capability, OpOutcome>>> {
    const out: Partial<Record<Capability, OpOutcome>> = {};
    for (const capability of [...this.#authored]) {
      if (this.#support[capability] !== 'SUPPORTED') continue;
      if (this.#takeFault(capability, 'restore') !== null) {
        out[capability] = failed('clear failed');
        continue;
      }
      // Clear the policy flags only. `enabled` is left exactly as it is: this
      // never switches a radio back on.
      const current = this.#state[capability];
      this.#state[capability] = {
        enabled: current.enabled,
        ...(current.autoJoinAllowed === undefined ? {} : { autoJoinAllowed: true }),
        ...(current.discoverable === undefined ? {} : { discoverable: true }),
        ...(current.tetheringActive === undefined ? {} : { tetheringActive: current.tetheringActive }),
      };
      this.#authored.delete(capability);
      out[capability] = succeeded(true);
    }
    return out;
  }

  /** Restrictions currently authored by this adapter (test visibility). */
  get authoredRestrictions(): Capability[] {
    return [...this.#authored].sort();
  }
}

/** The locked-down target for a capability. Never a toggle of the current value. */
export function lockedTarget(capability: Capability, current: CapabilityState): CapabilityState {
  switch (capability) {
    case 'wifi':
      return { enabled: 'OFF', autoJoinAllowed: false };
    case 'bluetooth':
      return { enabled: 'OFF', discoverable: false };
    case 'nearbySharing':
      return { enabled: 'OFF', discoverable: false };
    case 'hotspot':
      return { enabled: 'OFF', tetheringActive: false };
    case 'cellular':
    case 'nfc':
      return { enabled: 'OFF' };
    default: {
      const _exhaustive: never = capability;
      return current;
    }
  }
}

export function equalState(a: CapabilityState, b: CapabilityState): boolean {
  return (
    a.enabled === b.enabled &&
    a.autoJoinAllowed === b.autoJoinAllowed &&
    a.discoverable === b.discoverable &&
    a.tetheringActive === b.tetheringActive
  );
}
