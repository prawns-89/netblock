/**
 * Scenarios 8, 9, 10, 15, 16: the device or the process dies mid-transaction.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cmd, makeHarness, restart } from './_harness.ts';

test('8. controller disconnect during lockdown still restores on time', async () => {
  // At engine level a vanished controller is simply "no RESTORE ever arrives".
  // The durable timer is the only thing that matters.
  const h = await makeHarness({ holdMs: 50_000 });
  const before = h.adapter.deviceState;
  const lock = await h.engine.submit(cmd('LOCKDOWN', { clock: h.clock }));
  assert.equal(lock.status, 'LOCKED');

  await h.clock.advance(50_001);
  await h.engine.drain();

  assert.equal(h.engine.status.state, 'IDLE');
  assert.deepEqual(h.adapter.deviceState, before);
  await h.engine.shutdown();
});

test('9. phone reboot during lockdown: the hold had already elapsed', async () => {
  const h = await makeHarness({ holdMs: 50_000 });
  const before = h.adapter.deviceState;
  await h.engine.submit(cmd('LOCKDOWN', { clock: h.clock }));
  assert.equal(h.adapter.deviceState.wifi.enabled, 'OFF');
  await h.engine.shutdown();

  // Power cut. Nothing in memory survives; 3 minutes pass; the device boots.
  const h2 = await restart(h, { elapseMs: 180_000 });

  assert.equal(h2.engine.status.state, 'IDLE', 'startup recovery must restore');
  assert.deepEqual(h2.adapter.deviceState, before, 'exact prior state, from the snapshot');
  await h2.engine.shutdown();
});

test('9b. phone reboot during lockdown: still inside the hold window', async () => {
  const h = await makeHarness({ holdMs: 50_000 });
  const before = h.adapter.deviceState;
  const lock = await h.engine.submit(cmd('LOCKDOWN', { clock: h.clock }));
  await h.engine.shutdown();

  // Reboot after 20 of the 50 seconds.
  const h2 = await restart(h, { elapseMs: 20_000 });

  assert.equal(h2.engine.status.state, 'LOCKED', 'must stay locked for the remainder');
  assert.equal(h2.engine.status.activeLockdownId, lock.lockdownId, 'same transaction, not a new one');
  assert.equal(h2.adapter.deviceState.wifi.enabled, 'OFF');

  // Only the remaining 30 seconds, not a fresh 50.
  await h2.clock.advance(29_000);
  assert.equal(h2.engine.status.state, 'LOCKED');
  await h2.clock.advance(2_000);
  await h2.engine.drain();

  assert.equal(h2.engine.status.state, 'IDLE');
  assert.deepEqual(h2.adapter.deviceState, before);
  await h2.engine.shutdown();
});

test('10. application process killed mid-lockdown is rolled back on restart', async () => {
  const h = await makeHarness({ holdMs: 50_000 });
  const before = h.adapter.deviceState;

  // Kill the process *during* the apply loop: fail the 3rd capability with an
  // exception that escapes, leaving the record in PREPARING.
  const original = h.adapter.lockdown.bind(h.adapter);
  let applied = 0;
  (h.adapter as unknown as { lockdown: typeof original }).lockdown = async (capability) => {
    applied += 1;
    if (applied === 3) throw new Error('process killed');
    return original(capability);
  };

  await assert.rejects(() => h.engine.submit(cmd('LOCKDOWN', { clock: h.clock })));
  (h.adapter as unknown as { lockdown: typeof original }).lockdown = original;

  // The record must say PREPARING, with an accurate list of what was changed.
  const h2 = await restart(h, { elapseMs: 1_000 });

  assert.equal(h2.engine.status.state, 'IDLE', 'PREPARING must be rolled back, not resumed');
  assert.deepEqual(h2.adapter.deviceState, before, 'every change made before the kill is undone');
  assert.equal(h2.engine.status.activeLockdownId, null);
  await h2.engine.shutdown();
});

test('10b. restarting while IDLE changes nothing', async () => {
  const h = await makeHarness();
  const before = h.adapter.deviceState;
  const lock = await h.engine.submit(cmd('LOCKDOWN'));
  await h.engine.submit(cmd('RESTORE', { lockdownId: lock.lockdownId }));
  await h.engine.shutdown();

  const h2 = await restart(h, { elapseMs: 500_000 });
  assert.equal(h2.engine.status.state, 'IDLE');
  assert.deepEqual(h2.adapter.deviceState, before);
  // No connectivity operation at all during a clean startup.
  const callsBefore = h2.adapter.calls.length;
  const h3 = await restart(h2);
  assert.equal(h3.adapter.calls.length, callsBefore, 'a clean startup touches nothing');
  await h3.engine.shutdown();
});

test('15. corrupted persisted state lifts our restrictions without enabling anything', async () => {
  const h = await makeHarness({ holdMs: 50_000 });
  // The owner had NFC off beforehand; it must not come back on.
  h.adapter.setDeviceState({ nfc: { enabled: 'OFF' } });
  await h.engine.submit(cmd('LOCKDOWN', { clock: h.clock }));
  assert.ok(h.adapter.authoredRestrictions.includes('wifi'));
  await h.engine.shutdown();

  // Destroy both persisted slots.
  h.fs.corrupt('txn.a.json', '{"crc":"deadbeef","payload":"{}"}');
  h.fs.corrupt('txn.b.json', 'not json at all');

  const h2 = await restart(h, { elapseMs: 1_000 });

  assert.equal(h2.engine.status.integrity, 'BOTH_CORRUPT');
  assert.equal(h2.engine.status.state, 'IDLE');
  assert.deepEqual(h2.adapter.authoredRestrictions, [], 'every authored restriction is cleared');
  assert.equal(
    h2.adapter.deviceState.nfc.enabled,
    'OFF',
    'a capability the owner had off must stay off even in the corrupt path',
  );
  await h2.engine.shutdown();
});

test('15b. the hold policy takes no connectivity action on corrupt state', async () => {
  const h = await makeHarness();
  await h.engine.submit(cmd('LOCKDOWN'));
  const lockedState = h.adapter.deviceState;
  await h.engine.shutdown();

  h.fs.corrupt('txn.a.json', 'garbage');
  h.fs.corrupt('txn.b.json', 'garbage');

  const h2 = await restart(h, { corruptStatePolicy: 'hold' });
  assert.equal(h2.engine.status.state, 'ERROR');
  assert.deepEqual(h2.adapter.deviceState, lockedState, 'hold changes nothing automatically');

  // The owner's release valve is the documented way out.
  await h2.engine.release();
  assert.deepEqual(h2.adapter.authoredRestrictions, []);
  await h2.engine.shutdown();
});

test('16. power loss before a commit leaves the previous valid record intact', async () => {
  const h = await makeHarness({ holdMs: 50_000 });
  const before = h.adapter.deviceState;
  const lock = await h.engine.submit(cmd('LOCKDOWN', { clock: h.clock }));
  assert.equal(h.engine.status.state, 'LOCKED');
  await h.engine.shutdown();

  // The next write dies before its rename. The LOCKED record must survive.
  h.fs.armFault('before-commit');
  const h2 = await restart(h, { elapseMs: 10_000 });

  assert.equal(h2.engine.status.activeLockdownId, lock.lockdownId, 'the LOCKED record survived');
  // And recovery still completes correctly afterwards.
  h2.fs.clearFault();
  await h2.clock.advance(60_000);
  await h2.engine.drain();
  assert.equal(h2.engine.status.state, 'IDLE');
  assert.deepEqual(h2.adapter.deviceState, before);
  await h2.engine.shutdown();
});

test('16b. a torn write is detected by CRC and the previous slot is used', async () => {
  const h = await makeHarness({ holdMs: 50_000 });
  const before = h.adapter.deviceState;
  await h.engine.submit(cmd('LOCKDOWN', { clock: h.clock }));
  await h.engine.shutdown();

  // Truncate whichever slot holds the newest record, as a lost tail would.
  const files = h.fs.snapshotFiles();
  const newest = [...files.keys()]
    .filter((k) => k.startsWith('txn.'))
    .sort((a, b) => (files.get(b)?.length ?? 0) - (files.get(a)?.length ?? 0))[0]!;
  h.fs.corrupt(newest, (files.get(newest) ?? '').slice(0, 40));

  const h2 = await restart(h, { elapseMs: 1_000 });

  assert.equal(h2.engine.status.integrity, 'RECOVERED_FROM_PREVIOUS');
  // The fallback record is an earlier point in the SAME transaction, so
  // recovery still restores from a correct snapshot.
  await h2.clock.advance(120_000);
  await h2.engine.drain();
  assert.equal(h2.engine.status.state, 'IDLE');
  assert.deepEqual(h2.adapter.deviceState, before, 'no capability left half-modified');
  await h2.engine.shutdown();
});

test('16c. the snapshot is durable before the first irreversible change', async () => {
  const h = await makeHarness();
  // Fail the very first write of the transaction: the PREPARING commit.
  h.fs.armFault('before-commit');
  const before = h.adapter.deviceState;

  await assert.rejects(() => h.engine.submit(cmd('LOCKDOWN')));

  // Because the snapshot could not be persisted, nothing was changed at all.
  assert.deepEqual(h.adapter.deviceState, before, 'no change may precede a durable snapshot');
  assert.deepEqual(h.adapter.authoredRestrictions, []);
  await h.engine.shutdown();
});
