/**
 * The properties the rest of the suite relies on: one writer, ordered writes
 * before connectivity changes, bounded and redacted logs, and a snapshot that
 * structurally cannot carry user data.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AuditLog, sanitizeField } from '../src/core/audit-log.ts';
import { VirtualClock } from '../src/core/clock.ts';
import { MemoryAtomicFs } from '../src/core/fs-port.ts';
import { SerialExecutor } from '../src/core/serial-executor.ts';
import { StateManager } from '../src/core/state-manager.ts';
import { TransactionStore } from '../src/core/transaction-store.ts';
import { ALL_CAPABILITIES } from '../src/core/types.ts';
import type { Capability, CapabilityState, OpOutcome } from '../src/core/types.ts';
import { SimulatedConnectivityController } from '../src/adapters/simulated.ts';
import type { ConnectivityController, DataGuard } from '../src/adapters/port.ts';
import { seal, open, NonceSource } from '../src/protocol/envelope.ts';
import {
  decodePairingCode,
  deriveKeys,
  encodePairingCode,
  fingerprint,
  fingerprintsMatch,
  generatePairingSecret,
} from '../src/protocol/pairing.ts';
import { cmd, makeHarness } from './_harness.ts';

test('the serial executor never runs two tasks at once', async () => {
  const executor = new SerialExecutor();
  let active = 0;
  let peak = 0;
  const order: number[] = [];

  const tasks = Array.from({ length: 200 }, (_, i) =>
    executor.submit(async () => {
      active += 1;
      peak = Math.max(peak, active);
      // Multiple await points: a non-serial implementation interleaves here.
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, i % 3));
      await Promise.resolve();
      order.push(i);
      active -= 1;
    }),
  );
  await Promise.all(tasks);

  assert.equal(peak, 1, 'at most one task may ever be in flight');
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'strict submission order');
  assert.equal(executor.stats.maxObservedConcurrency, 1);
});

test('a throwing task does not break the executor chain', async () => {
  const executor = new SerialExecutor();
  await assert.rejects(() => executor.submit(async () => { throw new Error('boom'); }));
  assert.equal(await executor.submit(async () => 'still works'), 'still works');
  assert.equal(executor.stats.maxObservedConcurrency, 1);
});

test('application persistence is checkpointed before any connectivity change', async () => {
  const trace: string[] = [];
  const device = new SimulatedConnectivityController();

  const recording: ConnectivityController = {
    platform: 'simulated',
    getCapabilities: () => device.getCapabilities(),
    captureState: async () => {
      trace.push('captureState');
      return device.captureState();
    },
    lockdown: async (c: Capability): Promise<OpOutcome> => {
      trace.push(`lockdown:${c}`);
      return device.lockdown(c);
    },
    restore: async (c: Capability, d: CapabilityState): Promise<OpOutcome> => {
      trace.push(`restore:${c}`);
      return device.restore(c, d);
    },
    clearAuthoredRestrictions: () => device.clearAuthoredRestrictions(),
  };

  const guard: DataGuard = {
    quiesce: async () => {
      trace.push('quiesce');
    },
  };

  const fs = new MemoryAtomicFs();
  const clock = new VirtualClock();
  const store = new TransactionStore(fs, 'p');
  const audit = new AuditLog(fs, 50);
  const engine = new StateManager({
    deviceId: 'p',
    adapter: recording,
    store,
    audit,
    clock,
    holdMs: 50_000,
    dataGuard: guard,
    redundantAlarmMs: 0,
  });
  await engine.init();
  await engine.submit(cmd('LOCKDOWN', { deviceId: 'p' }));

  const quiesceAt = trace.indexOf('quiesce');
  const firstChange = trace.findIndex((t) => t.startsWith('lockdown:'));
  assert.ok(quiesceAt >= 0, 'the data guard must be invoked');
  assert.ok(quiesceAt < firstChange, 'our writes are flushed before connectivity is touched');
  assert.ok(fs.checkpointCount >= 1, 'the store is checkpointed too');
  await engine.shutdown();
});

test('the store alternates slots so a valid record always survives', async () => {
  const fs = new MemoryAtomicFs();
  const store = new TransactionStore(fs, 'dev');
  const base = store.fresh();

  await store.commit({ ...base, state: 'PREPARING', activeLockdownId: 'one' });
  await store.commit({ ...base, state: 'LOCKED', activeLockdownId: 'two' });

  const files = [...fs.snapshotFiles().keys()].filter((k) => k.startsWith('txn.')).sort();
  assert.deepEqual(files, ['txn.a.json', 'txn.b.json'], 'both slots in use, written alternately');

  const loaded = await store.load();
  assert.equal(loaded.integrity, 'OK');
  assert.equal(loaded.record?.activeLockdownId, 'two', 'the newest record wins');

  // The older slot still holds the earlier valid record, not a half-write.
  const slotContents = [...fs.snapshotFiles().entries()]
    .filter(([k]) => k.startsWith('txn.'))
    .map(([k, v]) => {
      const envelope = JSON.parse(v) as { payload: string };
      return { slot: k, record: JSON.parse(envelope.payload) as { activeLockdownId: string | null } };
    });
  assert.deepEqual(
    slotContents.map((s) => s.record.activeLockdownId).sort(),
    ['one', 'two'],
    'the previous valid record is intact in the other slot',
  );
});

test('the audit log is bounded and cannot grow indefinitely', async () => {
  const fs = new MemoryAtomicFs();
  const log = new AuditLog(fs, 20);
  await log.load();
  for (let i = 0; i < 500; i++) {
    await log.append({
      timestamp: i,
      deviceId: 'dev',
      operation: `op-${String(i)}`,
      result: 'SUCCESS',
    });
  }
  assert.equal(log.size, 20, 'capped at capacity');
  assert.equal(log.entries()[0]?.operation, 'op-480', 'oldest entries are dropped');

  const persisted = await fs.read('audit.json');
  assert.ok(persisted !== null);
  assert.ok(persisted.length < 8_000, 'the persisted file stays small');
});

test('the audit log redacts anything that could be a secret', async () => {
  // Field-level redaction.
  assert.equal(sanitizeField('password=hunter2'), '[redacted]');
  assert.equal(sanitizeField('joined SSID HomeNet'), '[redacted]');
  assert.equal(sanitizeField('psk mismatch'), '[redacted]');
  assert.equal(sanitizeField('peer aa:bb:cc:dd:ee:ff'), '[redacted]');
  assert.equal(sanitizeField('IMSI 310260000000000'), '[redacted]');
  assert.equal(sanitizeField('bearer token abc'), '[redacted]');
  // Benign operational text is kept.
  assert.equal(sanitizeField('radio busy'), 'radio busy');

  // Length is bounded, so a huge error string cannot bloat the log.
  const long = sanitizeField('x'.repeat(10_000));
  assert.ok(long !== null && long.length <= 200);

  const fs = new MemoryAtomicFs();
  const log = new AuditLog(fs, 10);
  await log.load();
  await log.append({
    timestamp: 1,
    deviceId: 'dev',
    operation: 'lockdown.wifi',
    result: 'FAILED',
    error: 'could not leave SSID CoffeeShopGuest',
  });
  const dump = JSON.stringify(log.entries());
  assert.ok(!dump.includes('CoffeeShopGuest'), 'no network name may reach the log');
});

test('a snapshot structurally cannot contain user data', async () => {
  const h = await makeHarness();
  await h.engine.submit(cmd('LOCKDOWN'));

  // Read the snapshot back out of the persisted record.
  const files = h.fs.snapshotFiles();
  const raw = [...files.entries()].find(([k]) => k.startsWith('txn.'))?.[1] ?? '';
  const record = JSON.parse(JSON.parse(raw).payload);
  const snapshot = record.snapshot;

  assert.deepEqual(
    Object.keys(snapshot).sort(),
    [
      'bluetoothState',
      'cellularState',
      'deviceId',
      'hotspotState',
      'lockdownId',
      'nearbySharingState',
      'nfcState',
      'successfullyModifiedCapabilities',
      'supportedCapabilities',
      'timestamp',
      'wifiState',
    ],
    'no field exists that could hold an SSID, key, pairing or SIM identifier',
  );

  for (const capability of ALL_CAPABILITIES) {
    const value = snapshot[`${capability === 'nearbySharing' ? 'nearbySharing' : capability}State`];
    for (const key of Object.keys(value)) {
      assert.ok(
        ['enabled', 'autoJoinAllowed', 'discoverable', 'tetheringActive'].includes(key),
        `unexpected snapshot field ${key}`,
      );
    }
    assert.ok(['ON', 'OFF', 'UNKNOWN'].includes(value.enabled));
  }
  await h.engine.shutdown();
});

test('pairing codes round-trip and the fingerprint detects a mistyped secret', () => {
  for (let i = 0; i < 200; i++) {
    const secret = generatePairingSecret();
    const code = encodePairingCode(secret);
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4})+$/);
    assert.deepEqual(decodePairingCode(code), secret, 'exact round-trip');
    // Visually ambiguous characters are accepted and mapped, not rejected.
    assert.deepEqual(decodePairingCode(code.toLowerCase().replace(/0/g, 'O')), secret);
  }

  const a = generatePairingSecret();
  const b = generatePairingSecret();
  assert.ok(fingerprintsMatch(fingerprint(a, 'dev'), fingerprint(a, 'dev')));
  assert.ok(!fingerprintsMatch(fingerprint(a, 'dev'), fingerprint(b, 'dev')));
  // The fingerprint is bound to the device, so the same secret elsewhere differs.
  assert.ok(!fingerprintsMatch(fingerprint(a, 'dev-1'), fingerprint(a, 'dev-2')));

  assert.throws(() => decodePairingCode('too-short'));
  assert.throws(() => decodePairingCode('!!!!-!!!!-!!!!-!!!!-!!!!-!!!!-!!!!-!!!!'));
});

test('envelopes detect tampering and cannot be replayed across directions', () => {
  const secret = generatePairingSecret();
  const keys = deriveKeys(secret, 'dev');
  const nonces = new NonceSource(0n);
  const sealed = seal({ type: 'PING', at: 1 }, keys.controllerToDevice, 'dev', nonces.next());

  assert.equal(open(sealed, keys.controllerToDevice, 'dev').ok, true);

  // The device-to-controller key must not open a controller-to-device frame.
  assert.equal(open(sealed, keys.deviceToController, 'dev').ok, false);
  // A frame for another device is refused even with the right key.
  assert.equal(open(sealed, keys.controllerToDevice, 'other').ok, false);
  // Any bit flipped in the ciphertext, the tag, the nonce or the deviceId fails.
  const flip = (s: string): string => {
    const buf = Buffer.from(s, 'base64');
    buf[0] = (buf[0]! ^ 0x01) & 0xff;
    return buf.toString('base64');
  };
  assert.equal(open({ ...sealed, ct: flip(sealed.ct) }, keys.controllerToDevice, 'dev').ok, false);
  assert.equal(open({ ...sealed, tag: flip(sealed.tag) }, keys.controllerToDevice, 'dev').ok, false);
  assert.equal(open({ ...sealed, nonce: flip(sealed.nonce) }, keys.controllerToDevice, 'dev').ok, false);
  assert.equal(open({ ...sealed, v: 2 }, keys.controllerToDevice, 'dev').ok, false);
});

test('nonces never repeat for a key', () => {
  const source = new NonceSource(0n);
  const seen = new Set<string>();
  for (let i = 0; i < 20_000; i++) {
    const nonce = source.next().toString('hex');
    assert.ok(!seen.has(nonce), 'nonce reuse under GCM would be catastrophic');
    seen.add(nonce);
  }
  // A restart that resumes from a reserved counter cannot collide either.
  const afterRestart = new NonceSource(20_000n);
  for (let i = 0; i < 1_000; i++) {
    assert.ok(!seen.has(afterRestart.next().toString('hex')));
  }
});

test('the engine only ever touches connectivity, never anything else', async () => {
  const h = await makeHarness();
  const lock = await h.engine.submit(cmd('LOCKDOWN'));
  await h.engine.submit(cmd('RESTORE', { lockdownId: lock.lockdownId }));

  // Every call the adapter received was a connectivity op on a known capability.
  for (const call of h.adapter.calls) {
    assert.ok(ALL_CAPABILITIES.includes(call.capability));
    assert.ok(['lockdown', 'restore'].includes(call.phase));
  }

  // Only the engine's own files were written: no user data path is reachable.
  const keys = [...h.fs.snapshotFiles().keys()].sort();
  for (const key of keys) {
    assert.match(key, /^(txn\.[ab]\.json|audit\.json|replay\.json|pairings\.json|identity\.json)$/);
  }
  await h.engine.shutdown();
});
