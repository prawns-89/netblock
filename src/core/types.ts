/**
 * Core domain types for the NetBlock lockdown engine.
 *
 * Design note on privacy: the state model can only represent a capability as
 * ON / OFF / UNKNOWN plus a small number of booleans. There is deliberately no
 * field anywhere in this file capable of holding an SSID, a pre-shared key, a
 * Bluetooth pairing, a SIM identifier or a phone number. Snapshots and audit
 * records are built exclusively from these types, so leaking that data is
 * structurally impossible rather than merely discouraged.
 */

export type Platform = 'android' | 'ios' | 'simulated';

/** Connectivity surfaces the engine may touch. Nothing else is ever modified. */
export type Capability =
  | 'wifi'
  | 'cellular'
  | 'bluetooth'
  | 'nfc'
  | 'nearbySharing'
  | 'hotspot';

export const ALL_CAPABILITIES = [
  'wifi',
  'cellular',
  'bluetooth',
  'nfc',
  'nearbySharing',
  'hotspot',
] as const satisfies readonly Capability[];

/**
 * Whether the OS officially exposes an API for this operation to *this build*.
 *
 * SUPPORTED          - an official, documented API exists and this process may call it.
 * UNSUPPORTED_BY_OS  - the platform exposes no official API for third parties. Never faked.
 * REQUIRES_PRIVILEGE - an official API exists but this build lacks the role
 *                      (e.g. Device Owner, supervised MDM). Treated as unsupported
 *                      at runtime; surfaced separately so the settings screen can
 *                      explain *why* rather than silently omitting the row.
 */
export type SupportLevel = 'SUPPORTED' | 'UNSUPPORTED_BY_OS' | 'REQUIRES_PRIVILEGE';

/** The official API family backing a capability. Documentation only; never a bypass. */
export type Mechanism =
  | 'android.DevicePolicyManager'
  | 'android.BluetoothAdapter'
  | 'android.NfcAdapter'
  | 'android.TetheringManager'
  | 'ios.MDM.Restrictions'
  | 'simulated'
  | 'none';

export type CapabilitySupport = {
  readonly capability: Capability;
  readonly support: SupportLevel;
  readonly mechanism: Mechanism;
  /** Short, non-personal explanation shown on the owner's settings screen. */
  readonly note: string;
};

export type CapabilityReport = {
  readonly platform: Platform;
  readonly entries: readonly CapabilitySupport[];
};

export type ToggleState = 'ON' | 'OFF' | 'UNKNOWN';

/**
 * Observed state of one capability. `detail` holds only booleans describing
 * policy flags, never configuration content.
 */
export type CapabilityState = {
  readonly enabled: ToggleState;
  /** Wi-Fi: whether the device may auto-join known networks. Saved networks are untouched. */
  readonly autoJoinAllowed?: boolean;
  /** Bluetooth / Nearby Share: whether the device is discoverable by others. */
  readonly discoverable?: boolean;
  /** Hotspot: whether the device is actively routing traffic for other devices. */
  readonly tetheringActive?: boolean;
};

export type StateSnapshotValues = {
  readonly [K in Capability]?: CapabilityState;
};

/** Outcome of one capability operation. Recorded verbatim; never rounded up to success. */
export type OpResult =
  | 'SUCCESS'
  | 'FAILED'
  | 'UNSUPPORTED'
  | 'NOT_ATTEMPTED'
  | 'NO_CHANGE_NEEDED';

export type OpOutcome = {
  readonly result: OpResult;
  /** True only when the device's observable state actually changed. Drives rollback. */
  readonly changed: boolean;
  /** Redacted, bounded error description. Never contains network or user content. */
  readonly error?: string;
};

export type ResultTable = { readonly [K in Capability]: OpOutcome };

/**
 * The transactional snapshot. Persisted atomically *before* any irreversible
 * change, and the sole source of truth for restoration. Field names follow the
 * specification exactly.
 */
export type Snapshot = {
  readonly deviceId: string;
  readonly lockdownId: string;
  readonly timestamp: number;

  readonly wifiState: CapabilityState;
  readonly cellularState: CapabilityState;
  readonly bluetoothState: CapabilityState;
  readonly nfcState: CapabilityState;
  readonly nearbySharingState: CapabilityState;
  readonly hotspotState: CapabilityState;

  readonly supportedCapabilities: readonly Capability[];
  /** Grows as operations succeed. Defines the exact rollback/restore set. */
  readonly successfullyModifiedCapabilities: readonly Capability[];
};

/** Maps a capability to its field name inside Snapshot. */
export const SNAPSHOT_FIELD = {
  wifi: 'wifiState',
  cellular: 'cellularState',
  bluetooth: 'bluetoothState',
  nfc: 'nfcState',
  nearbySharing: 'nearbySharingState',
  hotspot: 'hotspotState',
} as const satisfies Record<Capability, keyof Snapshot>;

export function snapshotValue(snapshot: Snapshot, capability: Capability): CapabilityState {
  return snapshot[SNAPSHOT_FIELD[capability]];
}

/** The lockdown state machine. */
export type LockdownState =
  | 'IDLE'
  | 'PREPARING'
  | 'LOCKED'
  | 'RESTORING'
  | 'ERROR'
  | 'RECOVERY';

export type CommandType = 'LOCKDOWN' | 'RESTORE' | 'TOGGLE' | 'TIMEOUT' | 'RECOVER' | 'STATUS';

export type Command = {
  readonly commandId: string;
  readonly deviceId: string;
  readonly type: CommandType;
  /**
   * Fence token. REQUIRED for TIMEOUT and RECOVER: a callback must prove it
   * belongs to the still-active transaction before it may change anything.
   * For RESTORE, null means "whatever transaction is active now", which is only
   * reachable inside the protocol's short command-expiry window.
   */
  readonly lockdownId: string | null;
  readonly timestamp: number;
  readonly expiresAt: number;
  /** Set when the command arrived over the wire; absent for internal timers. */
  readonly origin?: 'controller' | 'timer' | 'recovery' | 'local';
};

export type CommandStatus =
  | 'LOCKED'
  | 'RESTORED'
  | 'ALREADY_LOCKED'
  | 'ALREADY_IDLE'
  | 'LOCKDOWN_FAILED'
  | 'RESTORE_FAILED'
  | 'IGNORED_STALE'
  | 'IGNORED_EXPIRED'
  | 'IGNORED_WRONG_DEVICE'
  | 'IGNORED_DUPLICATE'
  | 'REJECTED_MALFORMED'
  | 'RECOVERED'
  | 'STATUS_OK';

export type CommandResult = {
  readonly commandId: string;
  readonly status: CommandStatus;
  readonly state: LockdownState;
  readonly lockdownId: string | null;
  readonly results?: ResultTable;
  readonly restoreDeadline?: number | null;
  readonly detail?: string;
};

/** Bounded, redacted audit record. */
export type AuditEntry = {
  readonly timestamp: number;
  readonly deviceId: string;
  readonly lockdownId: string | null;
  readonly commandId: string | null;
  readonly operation: string;
  readonly previousState: string | null;
  readonly requestedState: string | null;
  readonly result: string;
  readonly error: string | null;
};

/** Persisted transaction record. The single durable source of truth. */
export type TransactionRecord = {
  readonly schemaVersion: 1;
  /** Monotonic. Used to pick the newest valid A/B slot after a crash. */
  readonly seq: number;
  readonly deviceId: string;
  readonly state: LockdownState;
  readonly activeLockdownId: string | null;
  readonly snapshot: Snapshot | null;
  readonly results: ResultTable | null;
  /** Set when the LOCKED state was durably committed. The timer starts from here. */
  readonly committedAt: number | null;
  /** Absolute wall-clock deadline for automatic restoration. */
  readonly restoreDeadline: number | null;
  /** Incremented on every completed transaction; invalidates in-flight callbacks. */
  readonly generation: number;
  readonly lastError: string | null;
  /** Bounded exactly-once cache: commandId -> result. */
  readonly commandLog: readonly { readonly commandId: string; readonly result: CommandResult }[];
};

export const NO_RESULTS: ResultTable = {
  wifi: { result: 'NOT_ATTEMPTED', changed: false },
  cellular: { result: 'NOT_ATTEMPTED', changed: false },
  bluetooth: { result: 'NOT_ATTEMPTED', changed: false },
  nfc: { result: 'NOT_ATTEMPTED', changed: false },
  nearbySharing: { result: 'NOT_ATTEMPTED', changed: false },
  hotspot: { result: 'NOT_ATTEMPTED', changed: false },
};

export const UNKNOWN_STATE: CapabilityState = { enabled: 'UNKNOWN' };

export function initialRecord(deviceId: string): TransactionRecord {
  return {
    schemaVersion: 1,
    seq: 0,
    deviceId,
    state: 'IDLE',
    activeLockdownId: null,
    snapshot: null,
    results: null,
    committedAt: null,
    restoreDeadline: null,
    generation: 0,
    lastError: null,
    commandLog: [],
  };
}
