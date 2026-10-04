/**
 * Boundary between the TypeScript engine and platform-native code.
 *
 * The engine never reaches into the OS directly. Native modules expose a small,
 * fixed method set; every method maps onto one documented public platform API.
 * There is deliberately no generic "run this" escape hatch, so the bridge
 * cannot be used to reach an undocumented interface.
 */

import type { Capability } from '../core/types.ts';

export type ManagementRole = 'none' | 'profile-owner' | 'device-owner' | 'supervised-mdm';

export type NativeEnvironment = {
  readonly platform: 'android' | 'ios';
  /** Android: Build.VERSION.SDK_INT. iOS: major OS version. */
  readonly osVersion: number;
  readonly role: ManagementRole;
  readonly hasNfcHardware: boolean;
  readonly hasBluetoothHardware: boolean;
  readonly hasTelephonyHardware: boolean;
  /** Android only: this app holds UICC carrier privileges for the active SIM. */
  readonly hasCarrierPrivileges: boolean;
  /**
   * Methods the native layer confirmed it can invoke on *this* device. Produced
   * by non-destructive probes in native code, not by inference here.
   */
  readonly probedMethods: readonly string[];
};

export type NativeStateReading = {
  readonly enabled: 'ON' | 'OFF' | 'UNKNOWN';
  readonly autoJoinAllowed?: boolean;
  readonly discoverable?: boolean;
  readonly tetheringActive?: boolean;
};

export type NativeApplyRequest = {
  readonly capability: Capability;
  readonly enabled: 'ON' | 'OFF';
  readonly autoJoinAllowed?: boolean;
  readonly discoverable?: boolean;
};

export type NativeApplyResponse = {
  readonly ok: boolean;
  /** True only when the device's observable state actually changed. */
  readonly changed: boolean;
  /** Present when ok === false. Short, non-personal. */
  readonly error?: string;
  /** True when native code determined the OS exposes no API for this. */
  readonly unsupported?: boolean;
};

export interface NativeBridge {
  environment(): Promise<NativeEnvironment>;
  readState(): Promise<Partial<Record<Capability, NativeStateReading>>>;
  apply(request: NativeApplyRequest): Promise<NativeApplyResponse>;
  /** Disconnect active links without deleting pairings. Best effort. */
  disconnectActiveLinks(capability: Capability): Promise<NativeApplyResponse>;
  /**
   * Restrictions this application currently has in force, read back from the
   * platform (Android: UserManager.getUserRestrictions filtered to the keys we
   * author). Authoritative, so clearing them is attributable rather than a guess.
   */
  authoredRestrictions(): Promise<readonly Capability[]>;
  /** Clear one authored restriction. Must not change the radio's power state. */
  clearRestriction(capability: Capability): Promise<NativeApplyResponse>;
  /** Flush native-side persistence before connectivity changes. */
  flush(): Promise<void>;
}

/** Scriptable bridge for host-side tests of the platform adapters. */
export class FakeNativeBridge implements NativeBridge {
  #env: NativeEnvironment;
  #state: Partial<Record<Capability, NativeStateReading>>;
  readonly applied: NativeApplyRequest[] = [];
  readonly #authored = new Set<Capability>();
  #responder: ((r: NativeApplyRequest) => NativeApplyResponse) | null = null;

  constructor(env: NativeEnvironment, state: Partial<Record<Capability, NativeStateReading>> = {}) {
    this.#env = env;
    this.#state = structuredClone(state);
  }

  setResponder(fn: (r: NativeApplyRequest) => NativeApplyResponse): void {
    this.#responder = fn;
  }

  async environment(): Promise<NativeEnvironment> {
    return this.#env;
  }

  async readState(): Promise<Partial<Record<Capability, NativeStateReading>>> {
    return structuredClone(this.#state);
  }

  async apply(request: NativeApplyRequest): Promise<NativeApplyResponse> {
    this.applied.push(request);
    if (this.#responder !== null) return this.#responder(request);
    const before = this.#state[request.capability];
    const changed = before?.enabled !== request.enabled;
    if (request.enabled === 'OFF') this.#authored.add(request.capability);
    else this.#authored.delete(request.capability);
    this.#state[request.capability] = {
      enabled: request.enabled,
      ...(request.autoJoinAllowed === undefined ? {} : { autoJoinAllowed: request.autoJoinAllowed }),
      ...(request.discoverable === undefined ? {} : { discoverable: request.discoverable }),
    };
    return { ok: true, changed };
  }

  async disconnectActiveLinks(): Promise<NativeApplyResponse> {
    return { ok: true, changed: false };
  }

  async authoredRestrictions(): Promise<readonly Capability[]> {
    return [...this.#authored];
  }

  async clearRestriction(capability: Capability): Promise<NativeApplyResponse> {
    const had = this.#authored.delete(capability);
    return { ok: true, changed: had };
  }

  async flush(): Promise<void> {}
}
