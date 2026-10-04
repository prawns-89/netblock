/**
 * Scenarios 1-6: the normal lifecycle and idempotency.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cmd, makeHarness } from './_harness.ts';

test('1. normal LOCKDOWN then RESTORE returns the exact prior state', async () => {
  const h = await makeHarness();
  const before = h.adapter.deviceState;

  const lock = await h.engine.submit(cmd('LOCKDOWN'));
  assert.equal(lock.status, 'LOCKED');
  assert.equal(h.engine.status.state, 'LOCKED');
  assert.equal(h.adapter.deviceState.wifi.enabled, 'OFF');
  assert.equal(h.adapter.deviceState.bluetooth.enabled, 'OFF');

  const restore = await h.engine.submit(cmd('RESTORE', { lockdownId: lock.lockdownId }));
  assert.equal(restore.status, 'RESTORED');
  assert.equal(h.engine.status.state, 'IDLE');
  assert.deepEqual(h.adapter.deviceState, before, 'device state must be byte-identical to the snapshot');
  assert.equal(h.engine.status.activeLockdownId, null);
  await h.engine.shutdown();
});

test('1b. a capability that was already OFF is never switched ON by restore', async () => {
  // The owner had Wi-Fi and Bluetooth off before the lockdown.
  const h = await makeHarness({
    adapter: { initial: { wifi: { enabled: 'OFF', autoJoinAllowed: false }, bluetooth: { enabled: 'OFF', discoverable: false } } },
  });
  const before = h.adapter.deviceState;

  const lock = await h.engine.submit(cmd('LOCKDOWN'));
  assert.equal(lock.status, 'LOCKED');
  assert.equal(lock.results?.wifi.result, 'NO_CHANGE_NEEDED');
  assert.equal(lock.results?.bluetooth.result, 'NO_CHANGE_NEEDED');

  await h.engine.submit(cmd('RESTORE', { lockdownId: lock.lockdownId }));
  assert.equal(h.adapter.deviceState.wifi.enabled, 'OFF', 'must stay off: it was off beforehand');
  assert.equal(h.adapter.deviceState.bluetooth.enabled, 'OFF');
  assert.deepEqual(h.adapter.deviceState, before);

  // And it was never even attempted as a restore target.
  const restoreCalls = h.adapter.calls.filter((c) => c.phase === 'restore').map((c) => c.capability);
  assert.ok(!restoreCalls.includes('wifi'), 'wifi must not be a restore target');
  assert.ok(!restoreCalls.includes('bluetooth'));
  await h.engine.shutdown();
});

test('2. LOCKDOWN then the 50-second timeout restores automatically', async () => {
  const h = await makeHarness({ holdMs: 50_000 });
  const before = h.adapter.deviceState;

  const lock = await h.engine.submit(cmd('LOCKDOWN', { clock: h.clock }));
  assert.equal(lock.status, 'LOCKED');
  assert.equal(lock.restoreDeadline, h.clock.now() + 50_000);

  // The timer is armed only after LOCKED is committed, and carries the fence.
  assert.equal(h.wakeup.scheduled.length, 1);
  assert.equal(h.wakeup.scheduled[0]?.lockdownId, lock.lockdownId);

  await h.clock.advance(49_999);
  assert.equal(h.engine.status.state, 'LOCKED', 'must not restore a millisecond early');

  await h.clock.advance(2);
  await h.engine.drain();
  assert.equal(h.engine.status.state, 'IDLE');
  assert.deepEqual(h.adapter.deviceState, before);
  await h.engine.shutdown();
});

test('3. LOCKDOWN then an immediate RESTORE cancels the timer', async () => {
  const h = await makeHarness();
  const lock = await h.engine.submit(cmd('LOCKDOWN', { clock: h.clock }));
  const restore = await h.engine.submit(cmd('RESTORE', { lockdownId: lock.lockdownId, clock: h.clock }));
  assert.equal(restore.status, 'RESTORED');

  assert.equal(h.clock.pendingTimers, 0, 'the restore timer must be cancelled');
  assert.equal(h.wakeup.cancels >= 1, true, 'the OS alarm must be cancelled too');

  // Advancing past the old deadline must do nothing at all.
  const stateAfterRestore = h.adapter.deviceState;
  await h.clock.advance(60_000);
  await h.engine.drain();
  assert.equal(h.engine.status.state, 'IDLE');
  assert.deepEqual(h.adapter.deviceState, stateAfterRestore);
  await h.engine.shutdown();
});

test('4. duplicate LOCKDOWN is idempotent and does not extend the hold', async () => {
  const h = await makeHarness({ holdMs: 50_000 });
  const first = await h.engine.submit(cmd('LOCKDOWN', { clock: h.clock }));
  const deadline = first.restoreDeadline;
  const stateAfterFirst = h.adapter.deviceState;

  h.clock.jump(10_000);

  const second = await h.engine.submit(cmd('LOCKDOWN', { clock: h.clock }));
  const third = await h.engine.submit(cmd('LOCKDOWN', { clock: h.clock }));

  assert.equal(second.status, 'ALREADY_LOCKED');
  assert.equal(third.status, 'ALREADY_LOCKED');
  assert.equal(second.lockdownId, first.lockdownId, 'no new transaction may be created');
  assert.equal(second.restoreDeadline, deadline, 'the deadline must not move');
  assert.deepEqual(h.adapter.deviceState, stateAfterFirst, 'final state equals a single LOCKDOWN');

  // Exactly one snapshot, exactly one lockdownId, exactly one timer chain.
  assert.equal(h.wakeup.scheduled.length, 1);
  await h.engine.shutdown();
});

test('5. duplicate RESTORE cannot corrupt state or toggle anything back', async () => {
  const h = await makeHarness();
  const before = h.adapter.deviceState;
  const lock = await h.engine.submit(cmd('LOCKDOWN'));

  const r1 = await h.engine.submit(cmd('RESTORE', { lockdownId: lock.lockdownId }));
  const r2 = await h.engine.submit(cmd('RESTORE', { lockdownId: lock.lockdownId }));
  const r3 = await h.engine.submit(cmd('RESTORE', { lockdownId: null }));

  assert.equal(r1.status, 'RESTORED');
  // The second carries a lockdownId that is no longer active: fenced out.
  assert.equal(r2.status, 'ALREADY_IDLE');
  assert.equal(r3.status, 'ALREADY_IDLE');
  assert.deepEqual(h.adapter.deviceState, before, 'repeated restores must not move state');
  await h.engine.shutdown();
});

test('6. LOCKDOWN -> RESTORE -> LOCKDOWN produces a fresh, distinct transaction', async () => {
  const h = await makeHarness();
  const before = h.adapter.deviceState;

  const a = await h.engine.submit(cmd('LOCKDOWN'));
  await h.engine.submit(cmd('RESTORE', { lockdownId: a.lockdownId }));
  const b = await h.engine.submit(cmd('LOCKDOWN'));

  assert.notEqual(a.lockdownId, b.lockdownId, 'every activation needs a unique lockdownId');
  assert.equal(h.engine.status.state, 'LOCKED');

  await h.engine.submit(cmd('RESTORE', { lockdownId: b.lockdownId }));
  assert.deepEqual(h.adapter.deviceState, before);
  assert.equal(h.engine.status.generation, 2, 'two completed transactions');
  await h.engine.shutdown();
});

test('6b. TOGGLE resolves against live state inside the lock', async () => {
  const h = await makeHarness();
  const before = h.adapter.deviceState;

  const first = await h.engine.submit(cmd('TOGGLE'));
  assert.equal(first.status, 'LOCKED');

  const second = await h.engine.submit(cmd('TOGGLE'));
  assert.equal(second.status, 'RESTORED');
  assert.deepEqual(h.adapter.deviceState, before);

  const third = await h.engine.submit(cmd('TOGGLE'));
  assert.equal(third.status, 'LOCKED');
  assert.notEqual(third.lockdownId, first.lockdownId);
  await h.engine.shutdown();
});
