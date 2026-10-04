/**
 * The platform adapters' capability logic: the part that decides what is
 * honestly attemptable, and therefore the part that must never over-claim.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AndroidConnectivityController, evaluate } from '../src/adapters/android.ts';
import { IOSConnectivityController } from '../src/adapters/ios.ts';
import { FakeNativeBridge } from '../src/adapters/native-bridge.ts';
import type { NativeEnvironment } from '../src/adapters/native-bridge.ts';
import { ALL_CAPABILITIES } from '../src/core/types.ts';
import type { Capability, SupportLevel } from '../src/core/types.ts';

const DEVICE_OWNER_METHODS = [
  'setWifiEnabled',
  'userRestriction:no_config_wifi',
  'userRestriction:no_bluetooth',
  'userRestriction:no_config_tethering',
];

function env(overrides: Partial<NativeEnvironment> = {}): NativeEnvironment {
  return {
    platform: 'android',
    osVersion: 34,
    role: 'device-owner',
    hasNfcHardware: true,
    hasBluetoothHardware: true,
    hasTelephonyHardware: true,
    hasCarrierPrivileges: false,
    probedMethods: DEVICE_OWNER_METHODS,
    ...overrides,
  };
}

function matrix(e: NativeEnvironment): Record<Capability, SupportLevel> {
  return Object.fromEntries(
    ALL_CAPABILITIES.map((c) => [c, evaluate(c, e).support]),
  ) as Record<Capability, SupportLevel>;
}

test('android: NFC and Nearby Share are never claimed, at any privilege level', () => {
  for (const role of ['none', 'profile-owner', 'device-owner'] as const) {
    const report = matrix(env({ role, probedMethods: [...DEVICE_OWNER_METHODS, 'anything', 'else'] }));
    assert.equal(report.nfc, 'UNSUPPORTED_BY_OS', `nfc must stay unsupported for ${role}`);
    assert.equal(report.nearbySharing, 'UNSUPPORTED_BY_OS');
  }
});

test('android: a Device Owner gets wifi, bluetooth and hotspot', () => {
  assert.deepEqual(matrix(env()), {
    wifi: 'SUPPORTED',
    bluetooth: 'SUPPORTED',
    hotspot: 'SUPPORTED',
    // Carrier privileges absent, so this is a role problem, not an OS problem.
    cellular: 'REQUIRES_PRIVILEGE',
    nfc: 'UNSUPPORTED_BY_OS',
    nearbySharing: 'UNSUPPORTED_BY_OS',
  });
});

test('android: an ordinary install reports REQUIRES_PRIVILEGE, not SUPPORTED', () => {
  const report = matrix(env({ role: 'none', probedMethods: [] }));
  for (const capability of ALL_CAPABILITIES) {
    assert.notEqual(report[capability], 'SUPPORTED', `${capability} must not be claimed`);
  }
  assert.equal(report.wifi, 'REQUIRES_PRIVILEGE', 'the API exists; we lack the role');
  assert.equal(report.nfc, 'UNSUPPORTED_BY_OS', 'the API does not exist at all');
});

test('android: cellular needs carrier privileges, and says which it is', () => {
  assert.equal(matrix(env({ hasCarrierPrivileges: false })).cellular, 'REQUIRES_PRIVILEGE');
  assert.equal(
    matrix(env({ hasCarrierPrivileges: true, probedMethods: [...DEVICE_OWNER_METHODS, 'setDataEnabled'] })).cellular,
    'SUPPORTED',
  );
  assert.equal(matrix(env({ hasTelephonyHardware: false })).cellular, 'UNSUPPORTED_BY_OS');
});

test('android: absent hardware and old API levels are respected', () => {
  assert.equal(matrix(env({ hasBluetoothHardware: false })).bluetooth, 'UNSUPPORTED_BY_OS');
  assert.equal(matrix(env({ osVersion: 26 })).wifi, 'UNSUPPORTED_BY_OS');
});

test('android: the native probe is authoritative over the role', () => {
  // Claims Device Owner, but the device refused the required API checks.
  const report = matrix(env({ probedMethods: ['setWifiEnabled'] }));
  assert.equal(report.wifi, 'UNSUPPORTED_BY_OS', 'probe said no, so we do not try');
  assert.equal(report.bluetooth, 'UNSUPPORTED_BY_OS');
});

test('android: an unsupported capability is never attempted', async () => {
  const bridge = new FakeNativeBridge(env({ role: 'none', probedMethods: [] }), {
    wifi: { enabled: 'ON' },
  });
  const adapter = new AndroidConnectivityController(bridge);

  for (const capability of ALL_CAPABILITIES) {
    const outcome = await adapter.lockdown(capability);
    assert.equal(outcome.result, 'UNSUPPORTED');
    assert.equal(outcome.changed, false);
  }
  assert.deepEqual(bridge.applied, [], 'not a single native call was made');
});

test('android: restore refuses to guess when the prior value is UNKNOWN', async () => {
  const bridge = new FakeNativeBridge(env(), { wifi: { enabled: 'ON' } });
  const adapter = new AndroidConnectivityController(bridge);

  const outcome = await adapter.restore('wifi', { enabled: 'UNKNOWN' });
  assert.equal(outcome.result, 'UNSUPPORTED');
  assert.match(outcome.error ?? '', /refusing to guess/);
  assert.deepEqual(bridge.applied, [], 'nothing was written');
});

test('android: captureState records UNKNOWN for anything it may not control', async () => {
  const bridge = new FakeNativeBridge(env(), {
    wifi: { enabled: 'ON', autoJoinAllowed: true },
    nfc: { enabled: 'ON' },
  });
  const state = await new AndroidConnectivityController(bridge).captureState();

  assert.equal(state.wifi?.enabled, 'ON');
  // NFC is unsupported, so its real reading is deliberately discarded rather
  // than recorded as a value we might later "restore" to.
  assert.equal(state.nfc?.enabled, 'UNKNOWN');
  assert.equal(state.cellular?.enabled, 'UNKNOWN');
});

test('android: the release valve clears only what was read back as authored', async () => {
  const bridge = new FakeNativeBridge(env(), { wifi: { enabled: 'ON' }, bluetooth: { enabled: 'ON' } });
  const adapter = new AndroidConnectivityController(bridge);

  await adapter.lockdown('wifi');
  const cleared = await adapter.clearAuthoredRestrictions();

  assert.deepEqual(Object.keys(cleared), ['wifi'], 'only the one we actually authored');
  assert.equal(cleared.wifi?.result, 'SUCCESS');

  // Nothing left authored, so a second call is a clean no-op.
  assert.deepEqual(await adapter.clearAuthoredRestrictions(), {});
});

test('ios: a sideloaded app claims nothing at all', async () => {
  const bridge = new FakeNativeBridge({ ...env({ platform: 'ios', role: 'none' }) });
  const adapter = new IOSConnectivityController(bridge, 'app');

  const report = await adapter.getCapabilities();
  assert.equal(report.entries.length, ALL_CAPABILITIES.length);
  for (const entry of report.entries) {
    assert.equal(entry.support, 'UNSUPPORTED_BY_OS', `${entry.capability} must not be claimed`);
    assert.equal(entry.mechanism, 'none');
  }
  for (const capability of ALL_CAPABILITIES) {
    assert.equal((await adapter.lockdown(capability)).result, 'UNSUPPORTED');
  }
  assert.deepEqual(bridge.applied, []);
});

test('ios: supervised MDM gets AirDrop and hotspot, and nothing more', async () => {
  const bridge = new FakeNativeBridge(
    env({
      platform: 'ios',
      role: 'supervised-mdm',
      probedMethods: ['restriction:nearbySharing', 'restriction:hotspot'],
    }),
    { nearbySharing: { enabled: 'ON' }, hotspot: { enabled: 'ON' } },
  );
  const report = await new IOSConnectivityController(bridge, 'mdm').getCapabilities();
  const byCapability = Object.fromEntries(report.entries.map((e) => [e.capability, e.support]));

  assert.deepEqual(byCapability, {
    nearbySharing: 'SUPPORTED',
    hotspot: 'SUPPORTED',
    // MDM cannot power a radio off, so these stay honest.
    wifi: 'UNSUPPORTED_BY_OS',
    cellular: 'UNSUPPORTED_BY_OS',
    bluetooth: 'UNSUPPORTED_BY_OS',
    nfc: 'UNSUPPORTED_BY_OS',
  });
});

test('ios: mdm mode without enrolment reports REQUIRES_PRIVILEGE', async () => {
  const bridge = new FakeNativeBridge(env({ platform: 'ios', role: 'none', probedMethods: [] }));
  const report = await new IOSConnectivityController(bridge, 'mdm').getCapabilities();
  const airdrop = report.entries.find((e) => e.capability === 'nearbySharing');
  assert.equal(airdrop?.support, 'REQUIRES_PRIVILEGE');
  assert.match(airdrop?.note ?? '', /not supervised/);
});
