/**
 * Scenarios 7 and 12, plus the suite's central claim: no race can let an old
 * command or timer modify a newer transaction's state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cmd, makeHarness } from './_harness.ts';
import type { Command } from '../src/core/types.ts';

test('7. a timeout from an old lockdown must not restore a newer one', async () => {
  const h = await makeHarness({ holdMs: 50_000 });

  // Lockdown A
  const a = await h.engine.submit(cmd('LOCKDOWN', { clock: h.clock }));
  assert.equal(a.status, 'LOCKED');
  await h.engine.submit(cmd('RESTORE', { lockdownId: a.lockdownId, clock: h.clock }));

  // Lockdown B
  const b = await h.engine.submit(cmd('LOCKDOWN', { clock: h.clock }));
  assert.equal(b.status, 'LOCKED');
  assert.notEqual(a.lockdownId, b.lockdownId);
  const bDeadline = b.restoreDeadline;

  // Timeout A arrives late. It must be ignored: B is the live transaction.
  const staleTimeout: Command = {
    commandId: 'stale-timeout-a',
    deviceId: h.deviceId,
    type: 'TIMEOUT',
    lockdownId: a.lockdownId,
    timestamp: h.clock.now(),
    expiresAt: Number.POSITIVE_INFINITY,
    origin: 'timer',
  };
  const verdict = await h.engine.submit(staleTimeout);

  assert.equal(verdict.status, 'IGNORED_STALE');
  assert.equal(h.engine.status.state, 'LOCKED', 'B must still be locked');
  assert.equal(h.engine.status.activeLockdownId, b.lockdownId);
  assert.equal(h.engine.status.restoreDeadline, bDeadline, "B's deadline must be untouched");
  assert.equal(h.adapter.deviceState.wifi.enabled, 'OFF');

  // B's own timeout still works correctly afterwards.
  await h.clock.advance(50_001);
  await h.engine.drain();
  assert.equal(h.engine.status.state, 'IDLE');
  await h.engine.shutdown();
});

test('7b. a real in-flight timer from A cannot fire into B', async () => {
  // The hard version: A's timer is genuinely pending in the clock when B starts.
  const h = await makeHarness({ holdMs: 1_000 });

  const a = await h.engine.submit(cmd('LOCKDOWN', { clock: h.clock }));
  assert.equal(h.clock.pendingTimers, 1, "A's timer is live");

  // Restore A and immediately start B, all before A's timer would fire.
  await h.engine.submit(cmd('RESTORE', { lockdownId: a.lockdownId, clock: h.clock }));
  const b = await h.engine.submit(cmd('LOCKDOWN', { clock: h.clock }));

  // Drive time forward past where A's deadline was. Only B's timer may act.
  await h.clock.advance(1_001);
  await h.engine.drain();

  assert.equal(h.engine.status.state, 'IDLE');
  // Exactly two restores happened: A's explicit one and B's timeout. Not three.
  const restoreOps = h.adapter.calls.filter((c) => c.phase === 'restore' && c.capability === 'wifi');
  assert.equal(restoreOps.length, 2, 'wifi restored once per transaction, never more');
  assert.equal(h.engine.status.generation, 2);
  assert.notEqual(a.lockdownId, b.lockdownId);
  await h.engine.shutdown();
});

test('7c. a TIMEOUT with no fence token is rejected outright', async () => {
  const h = await makeHarness();
  await h.engine.submit(cmd('LOCKDOWN'));
  const result = await h.engine.submit({
    commandId: 'unfenced',
    deviceId: h.deviceId,
    type: 'TIMEOUT',
    lockdownId: null,
    timestamp: h.clock.now(),
    expiresAt: Number.POSITIVE_INFINITY,
    origin: 'timer',
  });
  assert.equal(result.status, 'REJECTED_MALFORMED');
  assert.equal(h.engine.status.state, 'LOCKED');
  await h.engine.shutdown();
});

test('12. two commands arriving simultaneously are serialized deterministically', async () => {
  const h = await makeHarness();
  const before = h.adapter.deviceState;

  // Submitted in the same tick, with no await between them.
  const [first, second] = await Promise.all([
    h.engine.submit(cmd('LOCKDOWN', { commandId: 'sim-1' })),
    h.engine.submit(cmd('LOCKDOWN', { commandId: 'sim-2' })),
  ]);

  // Submission order decides; the second sees a fully committed LOCKED state.
  assert.equal(first.status, 'LOCKED');
  assert.equal(second.status, 'ALREADY_LOCKED');
  assert.equal(first.lockdownId, second.lockdownId);
  assert.equal(h.engine.executorStats.maxObservedConcurrency, 1, 'never two writers at once');

  await h.engine.submit(cmd('RESTORE', { lockdownId: first.lockdownId }));
  assert.deepEqual(h.adapter.deviceState, before);
  await h.engine.shutdown();
});

test('12b. a storm of interleaved commands leaves a single consistent state', async () => {
  const h = await makeHarness({ holdMs: 50_000 });

  // LOCKDOWN / RESTORE / LOCKDOWN / RESTORE / STATUS, all fired at once.
  const results = await Promise.all([
    h.engine.submit(cmd('LOCKDOWN', { commandId: 'a' })),
    h.engine.submit(cmd('RESTORE', { commandId: 'b' })),
    h.engine.submit(cmd('LOCKDOWN', { commandId: 'c' })),
    h.engine.submit(cmd('RESTORE', { commandId: 'd' })),
    h.engine.submit(cmd('LOCKDOWN', { commandId: 'e' })),
    h.engine.submit(cmd('STATUS', { commandId: 'f' })),
  ]);

  assert.equal(h.engine.executorStats.maxObservedConcurrency, 1);
  assert.equal(results.length, 6);

  // The outcome is whatever the ordered queue produces, and it is coherent:
  // the engine's state matches the device's state, with no half-applied set.
  const status = h.engine.status;
  const wifi = h.adapter.deviceState.wifi.enabled;
  if (status.state === 'LOCKED') {
    assert.equal(wifi, 'OFF');
    assert.notEqual(status.activeLockdownId, null);
  } else {
    assert.equal(status.state, 'IDLE');
    assert.equal(wifi, 'ON');
    assert.equal(status.activeLockdownId, null);
  }
  await h.engine.shutdown();
});

test('12c. commands racing a firing timeout cannot interleave', async () => {
  const h = await makeHarness({ holdMs: 1_000 });
  const lock = await h.engine.submit(cmd('LOCKDOWN', { clock: h.clock }));

  // Fire the timeout and a competing RESTORE and LOCKDOWN in the same instant.
  const racing = Promise.all([
    h.engine.submit(cmd('RESTORE', { commandId: 'race-restore', lockdownId: lock.lockdownId, clock: h.clock })),
    h.engine.submit(cmd('LOCKDOWN', { commandId: 'race-lock', clock: h.clock })),
  ]);
  await h.clock.advance(1_001);
  await racing;
  await h.engine.drain();

  assert.equal(h.engine.executorStats.maxObservedConcurrency, 1);
  // Whatever order won, the device and the record agree.
  const status = h.engine.status;
  const wifi = h.adapter.deviceState.wifi.enabled;
  assert.equal(wifi, status.state === 'LOCKED' ? 'OFF' : 'ON');
  await h.engine.shutdown();
});

test('an old lockdownId can never be revived once its transaction completed', async () => {
  const h = await makeHarness();
  const a = await h.engine.submit(cmd('LOCKDOWN'));
  await h.engine.submit(cmd('RESTORE', { lockdownId: a.lockdownId }));
  const b = await h.engine.submit(cmd('LOCKDOWN'));

  // Every fenced command type carrying A's id must be refused.
  for (const type of ['RESTORE', 'TIMEOUT', 'RECOVER'] as const) {
    const res = await h.engine.submit(cmd(type, { lockdownId: a.lockdownId, commandId: `old-${type}` }));
    assert.equal(res.status, 'IGNORED_STALE', `${type} with a dead lockdownId must be ignored`);
    assert.equal(h.engine.status.activeLockdownId, b.lockdownId);
    assert.equal(h.engine.status.state, 'LOCKED');
  }
  await h.engine.shutdown();
});
