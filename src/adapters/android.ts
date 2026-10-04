/**
 * Android adapter.
 *
 * Capability support is decided by what the native layer *probed* successfully
 * on this device, combined with the app's management role. Nothing here is
 * assumed: `NativeEnvironment.probedMethods` is produced by non-destructive
 * checks in Kotlin (see native/android), and a capability whose required
 * methods are absent is reported UNSUPPORTED_BY_OS or REQUIRES_PRIVILEGE and
 * never attempted.
 *
 * Reality this encodes, rather than papers over:
 *  - An ordinary installed app targeting API 29+ cannot toggle Wi-Fi. Since API
 *    33 it cannot toggle Bluetooth either. It has never been able to disable
 *    cellular data, NFC, or tethering.
 *  - A Device Owner (DPC provisioned on a factory-reset device, which is the
 *    supported configuration for an owner locking down their own phone) gets
 *    Wi-Fi, Bluetooth and tethering through official DevicePolicyManager and
 *    UserManager restrictions.
 *  - Cellular data needs UICC carrier privileges or a system-signed build.
 *    Without them it stays UNSUPPORTED_BY_OS.
 *  - NFC and Nearby Share expose no public third-party or DPC toggle, so they
 *    are permanently UNSUPPORTED_BY_OS here.
 */

import type {
  Capability,
  CapabilityReport,
  CapabilityState,
  CapabilitySupport,
  Mechanism,
  OpOutcome,
  Platform,
  StateSnapshotValues,
  SupportLevel,
} from '../core/types.ts';
import { ALL_CAPABILITIES } from '../core/types.ts';
import type { ConnectivityController } from './port.ts';
import { failed, succeeded, unsupported } from './port.ts';
import type { NativeBridge, NativeEnvironment } from './native-bridge.ts';
import { lockedTarget } from './simulated.ts';

type Requirement = {
  readonly mechanism: Mechanism;
  /** All of these native methods must be probed-available. */
  readonly methods: readonly string[];
  readonly minSdk: number;
  readonly roles: readonly NativeEnvironment['role'][];
  readonly hardware?: 'nfc' | 'bluetooth' | 'telephony';
  readonly note: string;
  /** Explanation used when the role is insufficient but the API does exist. */
  readonly privilegeNote?: string;
};

/**
 * Required official APIs per capability. `methods` are the identifiers the
 * Kotlin module reports in `probedMethods`.
 */
const REQUIREMENTS: Record<Capability, Requirement | null> = {
  wifi: {
    mechanism: 'android.DevicePolicyManager',
    methods: ['setWifiEnabled', 'userRestriction:no_config_wifi'],
    minSdk: 28,
    roles: ['device-owner', 'profile-owner'],
    note: 'WifiManager.setWifiEnabled plus DISALLOW_CONFIG_WIFI; saved networks and keys untouched',
    privilegeNote:
      'Wi-Fi control requires Device Owner or Profile Owner provisioning; an ordinary install cannot toggle Wi-Fi on API 29+',
  },
  cellular: {
    mechanism: 'android.DevicePolicyManager',
    methods: ['setDataEnabled'],
    minSdk: 28,
    roles: ['device-owner', 'profile-owner'],
    hardware: 'telephony',
    note: 'TelephonyManager.setDataEnabled; needs UICC carrier privileges or a system-signed build. SIM/eSIM profiles untouched',
    privilegeNote:
      'Disabling cellular data needs UICC carrier privileges or a platform-signed build; Device Owner alone is not sufficient',
  },
  bluetooth: {
    mechanism: 'android.BluetoothAdapter',
    methods: ['userRestriction:no_bluetooth'],
    minSdk: 28,
    roles: ['device-owner'],
    hardware: 'bluetooth',
    note: 'UserManager.DISALLOW_BLUETOOTH via Device Owner; pairings are preserved',
    privilegeNote:
      'Bluetooth control requires Device Owner; apps targeting API 33+ cannot call BluetoothAdapter.disable()',
  },
  nfc: null, // No public third-party or DPC API disables the NFC radio.
  nearbySharing: null, // Nearby Share exposes no public toggle to apps or DPCs.
  hotspot: {
    mechanism: 'android.TetheringManager',
    methods: ['userRestriction:no_config_tethering'],
    minSdk: 28,
    roles: ['device-owner'],
    note: 'DISALLOW_CONFIG_TETHERING (and DISALLOW_WIFI_TETHERING on API 33+); hotspot SSID and password untouched',
    privilegeNote: 'Tethering restrictions require Device Owner',
  },
};

const PERMANENTLY_UNSUPPORTED: Partial<Record<Capability, string>> = {
  nfc: 'Android exposes no public API — for apps or Device Owners — that powers the NFC radio off',
  nearbySharing:
    'Nearby Share exposes no public API to disable it; suspending the provider package would be destructive and is not attempted',
};

export class AndroidConnectivityController implements ConnectivityController {
  readonly platform: Platform = 'android';
  readonly #bridge: NativeBridge;
  #env: NativeEnvironment | null = null;
  #report: CapabilityReport | null = null;

  constructor(bridge: NativeBridge) {
    this.#bridge = bridge;
  }

  async #environment(): Promise<NativeEnvironment> {
    this.#env ??= await this.#bridge.environment();
    return this.#env;
  }

  async getCapabilities(): Promise<CapabilityReport> {
    if (this.#report !== null) return this.#report;
    const env = await this.#environment();
    const entries: CapabilitySupport[] = ALL_CAPABILITIES.map((capability) =>
      evaluate(capability, env),
    );
    this.#report = { platform: 'android', entries };
    return this.#report;
  }

  async captureState(): Promise<StateSnapshotValues> {
    const report = await this.getCapabilities();
    const readings = await this.#bridge.readState();
    const out: Record<string, CapabilityState> = {};
    for (const entry of report.entries) {
      const reading = readings[entry.capability];
      // A capability we may not control is recorded UNKNOWN, never guessed —
      // restore() refuses to act on UNKNOWN rather than inventing a value.
      out[entry.capability] =
        entry.support === 'SUPPORTED' && reading !== undefined
          ? {
              enabled: reading.enabled,
              ...(reading.autoJoinAllowed === undefined
                ? {}
                : { autoJoinAllowed: reading.autoJoinAllowed }),
              ...(reading.discoverable === undefined ? {} : { discoverable: reading.discoverable }),
              ...(reading.tetheringActive === undefined
                ? {}
                : { tetheringActive: reading.tetheringActive }),
            }
          : { enabled: 'UNKNOWN' };
    }
    return out as StateSnapshotValues;
  }

  async lockdown(capability: Capability): Promise<OpOutcome> {
    const gate = await this.#gate(capability);
    if (gate !== null) return gate;

    const current = (await this.captureState())[capability] ?? { enabled: 'UNKNOWN' as const };
    const target = lockedTarget(capability, current);

    try {
      const res = await this.#bridge.apply({
        capability,
        enabled: 'OFF',
        ...(target.autoJoinAllowed === undefined ? {} : { autoJoinAllowed: target.autoJoinAllowed }),
        ...(target.discoverable === undefined ? {} : { discoverable: target.discoverable }),
      });
      if (res.unsupported === true) return unsupported(res.error ?? 'reported unsupported by OS');
      if (!res.ok) return failed(res.error ?? 'native apply failed');

      if (capability === 'bluetooth' || capability === 'hotspot') {
        // Drop live links without deleting pairings or hotspot configuration.
        await this.#bridge.disconnectActiveLinks(capability).catch(() => undefined);
      }
      return succeeded(res.changed);
    } catch (err) {
      return failed(describe(err));
    }
  }

  async restore(capability: Capability, desired: CapabilityState): Promise<OpOutcome> {
    const gate = await this.#gate(capability);
    if (gate !== null) return gate;
    if (desired.enabled === 'UNKNOWN') {
      return unsupported('no trustworthy prior value recorded; refusing to guess');
    }
    try {
      const res = await this.#bridge.apply({
        capability,
        enabled: desired.enabled,
        ...(desired.autoJoinAllowed === undefined
          ? {}
          : { autoJoinAllowed: desired.autoJoinAllowed }),
        ...(desired.discoverable === undefined ? {} : { discoverable: desired.discoverable }),
      });
      if (res.unsupported === true) return unsupported(res.error ?? 'reported unsupported by OS');
      if (!res.ok) return failed(res.error ?? 'native apply failed');
      return succeeded(res.changed);
    } catch (err) {
      return failed(describe(err));
    }
  }

  /**
   * Clear only the restrictions this app authored, read back from UserManager
   * so the set is a fact rather than an assumption. Radio power states are left
   * untouched: a Wi-Fi radio that is off is left off, because the owner may
   * have wanted it off.
   */
  async clearAuthoredRestrictions(): Promise<Partial<Record<Capability, OpOutcome>>> {
    const out: Partial<Record<Capability, OpOutcome>> = {};
    let authored: readonly Capability[] = [];
    try {
      authored = await this.#bridge.authoredRestrictions();
    } catch (err) {
      return { wifi: failed(`could not read authored restrictions: ${describe(err)}`) };
    }
    for (const capability of authored) {
      try {
        const res = await this.#bridge.clearRestriction(capability);
        out[capability] = res.ok
          ? succeeded(res.changed)
          : failed(res.error ?? 'clearRestriction failed');
      } catch (err) {
        out[capability] = failed(describe(err));
      }
    }
    return out;
  }

  async #gate(capability: Capability): Promise<OpOutcome | null> {
    const report = await this.getCapabilities();
    const entry = report.entries.find((e) => e.capability === capability);
    if (entry === undefined) return unsupported('unknown capability');
    if (entry.support !== 'SUPPORTED') return unsupported(entry.note);
    return null;
  }
}

export function evaluate(capability: Capability, env: NativeEnvironment): CapabilitySupport {
  const permanent = PERMANENTLY_UNSUPPORTED[capability];
  if (permanent !== undefined) {
    return { capability, support: 'UNSUPPORTED_BY_OS', mechanism: 'none', note: permanent };
  }

  const req = REQUIREMENTS[capability];
  if (req === null) {
    return {
      capability,
      support: 'UNSUPPORTED_BY_OS',
      mechanism: 'none',
      note: 'no official API available for this capability',
    };
  }

  if (req.hardware === 'nfc' && !env.hasNfcHardware) {
    return { capability, support: 'UNSUPPORTED_BY_OS', mechanism: 'none', note: 'no NFC hardware' };
  }
  if (req.hardware === 'bluetooth' && !env.hasBluetoothHardware) {
    return {
      capability,
      support: 'UNSUPPORTED_BY_OS',
      mechanism: 'none',
      note: 'no Bluetooth hardware',
    };
  }
  if (req.hardware === 'telephony' && !env.hasTelephonyHardware) {
    return {
      capability,
      support: 'UNSUPPORTED_BY_OS',
      mechanism: 'none',
      note: 'no cellular hardware',
    };
  }

  if (env.osVersion < req.minSdk) {
    return {
      capability,
      support: 'UNSUPPORTED_BY_OS',
      mechanism: 'none',
      note: `requires API ${req.minSdk} or newer`,
    };
  }

  // The native probe is authoritative: if the platform refused the capability
  // check on this device, we do not attempt the operation.
  const missing = req.methods.filter((m) => !env.probedMethods.includes(m));
  if (missing.length > 0) {
    const roleOk = req.roles.includes(env.role);
    const carrierOk = capability !== 'cellular' || env.hasCarrierPrivileges;
    const support: SupportLevel = roleOk && carrierOk ? 'UNSUPPORTED_BY_OS' : 'REQUIRES_PRIVILEGE';
    return {
      capability,
      support,
      mechanism: 'none',
      note:
        support === 'REQUIRES_PRIVILEGE'
          ? (req.privilegeNote ?? 'insufficient management role')
          : `device refused the required API (${missing.join(', ')})`,
    };
  }

  return { capability, support: 'SUPPORTED', mechanism: req.mechanism, note: req.note };
}

function describe(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 200); // bounded, and carries no network or user content
}
