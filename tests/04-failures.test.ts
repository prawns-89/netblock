/**
 * Scenarios 11, 17, 18: partial failure, unsupported capabilities, and a
 * restore that will not succeed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cmd, makeHarness, restart } from './_harness.ts';
import { SimulatedConnectivityController } from '../src/adapters/simulated.ts';

test('11. a partial connectivity failure rolls the whole transaction back', async () => {
  const device = new SimulatedConnectivityController();
  // Wi-Fi and Bluetooth will succeed; cellular will fail, as in the brief.
  device.injectFault({ capability: 'cellular', phase: 'lockdown', message: 'radio busy' });
  const h = await makeHarness({ device });
  const before = h.adapter.deviceState;

  const result = await h.engine.submit(cmd('LOCKDOWN'));

  assert.equal(result.status, 'LOCKDOWN_FAILED', 'must not pretend lockdown succeeded');
  // The exact result of every operation is recorded, not rounded up.
  assert.equal(result.results?.wifi.result, 'SUCCESS');
  assert.equal(result.results?.bluetooth.result, 'SUCCESS');
  assert.equal(result.results?.cellular.result, 'FAILED');
  assert.equal(result.results?.hotspot.result, 'NO_CHANGE_NEEDED');

  // Everything successfully modified in this transaction is put back.
  assert.deepEqual(h.adapter.deviceState, before, 'no half-modified state may remain');
  assert.deepEqual(h.adapter.authoredRestrictions, []);
  assert.equal(h.engine.status.state, 'IDLE', 'a known state, not ERROR');
  assert.equal(h.engine.status.activeLockdownId, null);
  await h.engine.shutdown();
});

test('11b. the per-operation result table is reported verbatim', async () => {
  const device = new SimulatedConnectivityController({
    support: { nfc: 'UNSUPPORTED_BY_OS', nearbySharing: 'REQUIRES_PRIVILEGE' },
    initial: { hotspot: { enabled: 'OFF', tetheringActive: false } },
  });
  const h = await makeHarness({ device });

  const result = await h.engine.submit(cmd('LOCKDOWN'));
  assert.equal(result.status, 'LOCKED');

  assert.deepEqual(
    Object.fromEntries(Object.entries(result.results!).map(([k, v]) => [k, v.result])),
    {
      wifi: 'SUCCESS',
      cellular: 'SUCCESS',
      bluetooth: 'SUCCESS',
      nfc: 'UNSUPPORTED',
      nearbySharing: 'UNSUPPORTED',
      hotspot: 'NO_CHANGE_NEEDED',
    },
    'every outcome distinct: SUCCESS, UNSUPPORTED and NO_CHANGE_NEEDED are not conflated',
  );
  // An UNSUPPORTED capability is never counted as a failure, so the lockdown
  // commits with the operations that are actually permitted.
  await h.engine.submit(cmd('RESTORE', { lockdownId: result.lockdownId }));
  await h.engine.shutdown();
});

test('11c. rollback failure preserves the snapshot for a later retry', async () => {
  const device = new SimulatedConnectivityController();
  device.injectFault({ capability: 'cellular', phase: 'lockdown', message: 'radio busy' });
  // Rolling Wi-Fi back fails once, so the rollback itself is incomplete.
  device.injectFault({ capability: 'wifi', phase: 'restore', message: 'driver wedged', remaining: 1 });
  const h = await makeHarness({ device, restoreAttempts: 1 });
  const before = h.adapter.deviceState;

  const result = await h.engine.submit(cmd('LOCKDOWN'));
  assert.equal(result.status, 'RESTORE_FAILED');
  assert.equal(h.engine.status.state, 'ERROR', 'an incomplete rollback is ERROR, not IDLE');
  assert.notEqual(h.engine.status.activeLockdownId, null, 'the transaction identity is kept');

  // A new lockdown is refused while the old one is unresolved: starting one
  // would overwrite the snapshot that is still needed.
  const refused = await h.engine.submit(cmd('LOCKDOWN', { commandId: 'second' }));
  assert.equal(refused.status, 'LOCKDOWN_FAILED');
  assert.equal(h.engine.status.state, 'ERROR');

  // Recovery on restart retries against the preserved snapshot and succeeds.
  await h.engine.shutdown();
  const h2 = await restart(h, { elapseMs: 1_000 });
  assert.equal(h2.engine.status.state, 'IDLE');
  assert.deepEqual(h2.adapter.deviceState, before, 'recovered to the exact prior state');
  await h2.engine.shutdown();
});

test('17. when the OS permits nothing, lockdown reports it instead of faking it', async () => {
  const h = await makeHarness({
    adapter: {
      support: {
        wifi: 'REQUIRES_PRIVILEGE',
        cellular: 'UNSUPPORTED_BY_OS',
        bluetooth: 'REQUIRES_PRIVILEGE',
        nfc: 'UNSUPPORTED_BY_OS',
        nearbySharing: 'UNSUPPORTED_BY_OS',
        hotspot: 'REQUIRES_PRIVILEGE',
      },
    },
  });
  const before = h.adapter.deviceState;

  const result = await h.engine.submit(cmd('LOCKDOWN'));

  assert.equal(result.status, 'LOCKDOWN_FAILED');
  assert.equal(result.state, 'IDLE', 'LOCKED is never entered on a device that permits nothing');
  assert.match(result.detail ?? '', /no connectivity capability/);
  for (const outcome of Object.values(result.results!)) {
    assert.equal(outcome.result, 'UNSUPPORTED');
  }
  assert.deepEqual(h.adapter.deviceState, before, 'nothing was touched');
  assert.equal(h.clock.pendingTimers, 0, 'no restore timer for a lockdown that never happened');
  await h.engine.shutdown();
});

test('17b. a partially capable device locks down only what it may', async () => {
  const h = await makeHarness({
    adapter: {
      support: { cellular: 'UNSUPPORTED_BY_OS', nfc: 'UNSUPPORTED_BY_OS', nearbySharing: 'UNSUPPORTED_BY_OS' },
    },
  });
  const before = h.adapter.deviceState;

  const lock = await h.engine.submit(cmd('LOCKDOWN'));
  assert.equal(lock.status, 'LOCKED');
  assert.equal(h.adapter.deviceState.wifi.enabled, 'OFF');
  assert.equal(h.adapter.deviceState.cellular.enabled, 'ON', 'untouched, because it may not be touched');

  await h.engine.submit(cmd('RESTORE', { lockdownId: lock.lockdownId }));
  assert.deepEqual(h.adapter.deviceState, before);
  await h.engine.shutdown();
});

test('18. a permanently failing restore holds ERROR and keeps retrying safely', async () => {
  const device = new SimulatedConnectivityController();
  const h = await makeHarness({ device, holdMs: 50_000, restoreAttempts: 2 });
  const before = h.adapter.deviceState;

  const lock = await h.engine.submit(cmd('LOCKDOWN', { clock: h.clock }));
  assert.equal(lock.status, 'LOCKED');

  // Bluetooth can never be restored from here on.
  device.injectFault({ capability: 'bluetooth', phase: 'restore', message: 'adapter gone' });

  const restore = await h.engine.submit(cmd('RESTORE', { lockdownId: lock.lockdownId, clock: h.clock }));
  assert.equal(restore.status, 'RESTORE_FAILED');
  assert.equal(restore.results?.bluetooth.result, 'FAILED');
  assert.equal(h.engine.status.state, 'ERROR');

  // Everything that COULD be restored was, so the failure is isolated.
  assert.equal(h.adapter.deviceState.wifi.enabled, 'ON');
  assert.equal(h.adapter.deviceState.cellular.enabled, 'ON');
  assert.equal(h.adapter.deviceState.bluetooth.enabled, 'OFF', 'the one that failed');

  // Repeated recovery attempts are safe and never make things worse.
  for (let i = 0; i < 3; i++) {
    const again = await h.engine.submit(
      cmd('RECOVER', { commandId: `retry-${String(i)}`, lockdownId: h.engine.status.activeLockdownId }),
    );
    assert.equal(again.status, 'RESTORE_FAILED');
    assert.equal(h.adapter.deviceState.wifi.enabled, 'ON', 'already-restored values must not regress');
  }

  // Once the hardware recovers, the preserved snapshot restores it exactly.
  device.clearFaults();
  const final = await h.engine.submit(
    cmd('RECOVER', { commandId: 'final', lockdownId: h.engine.status.activeLockdownId }),
  );
  assert.equal(final.status, 'RECOVERED');
  assert.equal(h.engine.status.state, 'IDLE');
  assert.deepEqual(h.adapter.deviceState, before);
  await h.engine.shutdown();
});

test('18b. a retried restore eventually succeeds within its attempt budget', async () => {
  const device = new SimulatedConnectivityController();
  device.injectFault({ capability: 'wifi', phase: 'restore', message: 'transient', remaining: 1 });
  const h = await makeHarness({ device, restoreAttempts: 3 });
  const before = h.adapter.deviceState;

  const lock = await h.engine.submit(cmd('LOCKDOWN'));
  const restore = await h.engine.submit(cmd('RESTORE', { lockdownId: lock.lockdownId }));

  assert.equal(restore.status, 'RESTORED');
  assert.deepEqual(h.adapter.deviceState, before);
  await h.engine.shutdown();
});
