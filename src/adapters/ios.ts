/**
 * iOS adapter.
 *
 * The honest position, stated in code rather than buried in a README:
 *
 *  - A user-installed iOS app cannot power Wi-Fi, cellular data, Bluetooth or
 *    NFC on or off, cannot disable AirDrop, and cannot disable Personal
 *    Hotspot. No public API exists. There is no entitlement that grants it.
 *    In `app` mode every capability therefore reports UNSUPPORTED_BY_OS and the
 *    engine proceeds with whatever the *other* paired phones can do.
 *
 *  - A *supervised* device enrolled with an MDM server can apply two relevant
 *    official restrictions: `allowAirDrop` and `allowPersonalHotspotModification`.
 *    Even then MDM cannot power a radio off — `allowBluetoothModification` only
 *    locks the user's toggle, it does not switch Bluetooth off, so Bluetooth
 *    stays UNSUPPORTED_BY_OS here rather than being claimed.
 *
 *  - MDM is not peer-to-peer: pushing a restriction requires Apple's push
 *    service. `mdm` mode is therefore opt-in and documented as depending on
 *    Apple infrastructure, unlike the Android path which is fully local.
 */

import type {
  Capability,
  CapabilityReport,
  CapabilityState,
  CapabilitySupport,
  OpOutcome,
  Platform,
  StateSnapshotValues,
} from '../core/types.ts';
import { ALL_CAPABILITIES } from '../core/types.ts';
import type { ConnectivityController } from './port.ts';
import { failed, succeeded, unsupported } from './port.ts';
import type { NativeBridge, NativeEnvironment, NativeStateReading } from './native-bridge.ts';

export type IosMode = 'app' | 'mdm';

const APP_MODE_NOTES: Record<Capability, string> = {
  wifi: 'iOS exposes no public API to power Wi-Fi off or block auto-join from an app',
  cellular: 'iOS exposes no public API to disable cellular data from an app',
  bluetooth: 'iOS exposes no public API to power Bluetooth off from an app',
  nfc: 'iOS exposes no public API to disable the NFC radio',
  nearbySharing: 'disabling AirDrop requires a supervised device and an MDM restriction',
  hotspot: 'disabling Personal Hotspot requires a supervised device and an MDM restriction',
};

/** Capabilities a supervised, MDM-enrolled device can actually restrict. */
const MDM_SUPPORTED: Partial<Record<Capability, { readonly note: string }>> = {
  nearbySharing: {
    note: 'MDM restriction allowAirDrop=false on a supervised device; the previous value is restored afterwards',
  },
  hotspot: {
    note: 'MDM restriction allowPersonalHotspotModification=false on a supervised device; prevents the device acting as a gateway. Hotspot SSID and password are untouched. An already-active session is not torn down by this restriction',
  },
};

export class IOSConnectivityController implements ConnectivityController {
  readonly platform: Platform = 'ios';
  readonly #bridge: NativeBridge;
  readonly #mode: IosMode;
  #env: NativeEnvironment | null = null;
  #report: CapabilityReport | null = null;

  constructor(bridge: NativeBridge, mode: IosMode = 'app') {
    this.#bridge = bridge;
    this.#mode = mode;
  }

  async getCapabilities(): Promise<CapabilityReport> {
    if (this.#report !== null) return this.#report;
    this.#env ??= await this.#bridge.environment();
    const env = this.#env;

    const entries: CapabilitySupport[] = ALL_CAPABILITIES.map((capability): CapabilitySupport => {
      if (this.#mode === 'app') {
        return {
          capability,
          support: 'UNSUPPORTED_BY_OS',
          mechanism: 'none',
          note: APP_MODE_NOTES[capability],
        };
      }
      const mdm = MDM_SUPPORTED[capability];
      if (mdm === undefined) {
        return {
          capability,
          support: 'UNSUPPORTED_BY_OS',
          mechanism: 'none',
          note: APP_MODE_NOTES[capability],
        };
      }
      if (env.role !== 'supervised-mdm') {
        return {
          capability,
          support: 'REQUIRES_PRIVILEGE',
          mechanism: 'ios.MDM.Restrictions',
          note: 'device is not supervised and MDM-enrolled; restriction cannot be applied',
        };
      }
      if (!env.probedMethods.includes(`restriction:${capability}`)) {
        return {
          capability,
          support: 'UNSUPPORTED_BY_OS',
          mechanism: 'none',
          note: 'the enrolled MDM channel did not accept this restriction on this device',
        };
      }
      return {
        capability,
        support: 'SUPPORTED',
        mechanism: 'ios.MDM.Restrictions',
        note: mdm.note,
      };
    });

    this.#report = { platform: 'ios', entries };
    return this.#report;
  }

  async captureState(): Promise<StateSnapshotValues> {
    const report = await this.getCapabilities();
    const readings: Partial<Record<Capability, NativeStateReading>> = await this.#bridge
      .readState()
      .catch(() => ({}));
    const out: Record<string, CapabilityState> = {};
    for (const entry of report.entries) {
      const reading = readings[entry.capability];
      out[entry.capability] =
        entry.support === 'SUPPORTED' && reading !== undefined
          ? { enabled: reading.enabled }
          : { enabled: 'UNKNOWN' };
    }
    return out as StateSnapshotValues;
  }

  async lockdown(capability: Capability): Promise<OpOutcome> {
    const gate = await this.#gate(capability);
    if (gate !== null) return gate;
    try {
      const res = await this.#bridge.apply({ capability, enabled: 'OFF' });
      if (res.unsupported === true) return unsupported(res.error ?? 'reported unsupported by OS');
      return res.ok ? succeeded(res.changed) : failed(res.error ?? 'MDM restriction not applied');
    } catch (err) {
      return failed(err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    }
  }

  async restore(capability: Capability, desired: CapabilityState): Promise<OpOutcome> {
    const gate = await this.#gate(capability);
    if (gate !== null) return gate;
    if (desired.enabled === 'UNKNOWN') {
      return unsupported('no trustworthy prior value recorded; refusing to guess');
    }
    try {
      const res = await this.#bridge.apply({ capability, enabled: desired.enabled });
      if (res.unsupported === true) return unsupported(res.error ?? 'reported unsupported by OS');
      return res.ok ? succeeded(res.changed) : failed(res.error ?? 'MDM restriction not applied');
    } catch (err) {
      return failed(err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    }
  }

  /** iOS restrictions are MDM-authored; clearing them removes the payload keys. */
  async clearAuthoredRestrictions(): Promise<Partial<Record<Capability, OpOutcome>>> {
    if (this.#mode === 'app') return {};
    const out: Partial<Record<Capability, OpOutcome>> = {};
    const authored = await this.#bridge.authoredRestrictions().catch(() => [] as const);
    for (const capability of authored) {
      const res = await this.#bridge
        .clearRestriction(capability)
        .catch(() => ({ ok: false, changed: false, error: 'bridge error' }));
      out[capability] = res.ok ? succeeded(res.changed) : failed(res.error ?? 'failed');
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
