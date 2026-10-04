/**
 * Scenarios 13, 14, 19 and the command-protocol rejection rules, exercised
 * over real TCP sockets with the real AEAD wire format.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { MemoryAtomicFs } from '../src/core/fs-port.ts';
import { SystemClock } from '../src/core/clock.ts';
import { ControllerClient } from '../src/controller/client.ts';
import { generatePairingSecret } from '../src/protocol/pairing.ts';
import { encodeFrame } from '../src/protocol/framing.ts';
import { CuttableProxy, makeLink, RawClient } from './_link.ts';
import type { ReplyFrame, RejectFrame } from '../src/protocol/session.ts';

test('13. a duplicated network packet is applied exactly once', async () => {
  const link = await makeLink();
  const raw = new RawClient(link.record);
  await raw.connect(link.port);
  await raw.hello();

  const command = raw.command({ type: 'LOCKDOWN' });

  // The same command frame, delivered three times, as a retrying network would.
  raw.send(command);
  raw.send({ ...command, seq: raw.nextSeq() });
  raw.send({ ...command, seq: raw.nextSeq() });

  const replies: ReplyFrame[] = [];
  const deadline = Date.now() + 2_000;
  while (replies.length < 3 && Date.now() < deadline) {
    replies.length = 0;
    replies.push(...(raw.received.filter((m) => m.type === 'REPLY') as ReplyFrame[]));
    await new Promise((r) => setTimeout(r, 10));
  }

  assert.equal(replies.length, 3, 'every delivery gets an answer');
  assert.equal(replies[0]?.cached, false, 'the first is real work');
  assert.equal(replies[1]?.cached, true, 'the rest come from the exactly-once cache');
  assert.equal(replies[2]?.cached, true);
  assert.equal(replies[0]?.result.status, 'LOCKED');
  assert.equal(replies[1]?.result.status, 'IGNORED_DUPLICATE');

  // One transaction, one snapshot, one timer.
  assert.equal(link.engine.status.state, 'LOCKED');
  assert.equal(link.engine.status.activeLockdownId, replies[0]?.result.lockdownId);

  // The device applied the lockdown once: wifi was touched a single time.
  const wifiLockdowns = link.adapter.calls.filter((c) => c.capability === 'wifi' && c.phase === 'lockdown');
  assert.equal(wifiLockdowns.length, 1);

  raw.close();
  await link.close();
});

test('14. a delayed packet with a stale sequence number is rejected', async () => {
  const link = await makeLink();
  const raw = new RawClient(link.record);
  await raw.connect(link.port);
  await raw.hello();

  // A fresh command establishes the sequence high-water mark.
  const current = raw.command({ type: 'STATUS', seq: 10 });
  raw.send(current);
  await raw.waitFor((m) => m.type === 'REPLY');

  // Now a command that was delayed in the network arrives late, with an older
  // seq and a commandId never seen before.
  const delayed = raw.command({ type: 'LOCKDOWN', seq: 4 });
  raw.send(delayed);

  const reject = (await raw.waitFor((m) => m.type === 'REJECT')) as RejectFrame;
  assert.equal(reject.code, 'OUT_OF_ORDER');
  assert.equal(link.engine.status.state, 'IDLE', 'the stale frame changed nothing');

  raw.close();
  await link.close();
});

test('14b. an expired command is rejected even if it is otherwise valid', async () => {
  const link = await makeLink();
  const raw = new RawClient(link.record);
  await raw.connect(link.port);
  await raw.hello();

  const now = Date.now();
  raw.send(raw.command({ type: 'LOCKDOWN', timestamp: now - 30_000, expiresAt: now - 15_000 }));

  const reject = (await raw.waitFor((m) => m.type === 'REJECT')) as RejectFrame;
  assert.equal(reject.code, 'EXPIRED');
  assert.equal(link.engine.status.state, 'IDLE');

  raw.close();
  await link.close();
});

test('14c. a command with an implausible timestamp is rejected', async () => {
  const link = await makeLink();
  const raw = new RawClient(link.record);
  await raw.connect(link.port);
  await raw.hello();

  const now = Date.now();
  // Far-future timestamp but a valid expiry: outside the accepted clock window.
  raw.send(raw.command({ type: 'LOCKDOWN', timestamp: now + 10 * 60_000, expiresAt: now + 11 * 60_000 }));

  const reject = (await raw.waitFor((m) => m.type === 'REJECT')) as RejectFrame;
  assert.equal(reject.code, 'CLOCK_SKEW');
  assert.equal(link.engine.status.state, 'IDLE');

  raw.close();
  await link.close();
});

test('an unknown controller cannot issue commands', async () => {
  const link = await makeLink();
  // Right device id, wrong secret: the key is not on record.
  const impostor = new RawClient(link.record, generatePairingSecret());
  await impostor.connect(link.port);
  impostor.write({ type: 'HELLO', sessionId: randomUUID(), lastSentSeq: 0, sentAt: Date.now() });

  await impostor.waitForClose();
  assert.equal(link.engine.status.state, 'IDLE', 'nothing happened');
  assert.equal(impostor.received.length, 0, 'not a single byte of reply');

  await link.close();
});

test('a command addressed to another device is refused', async () => {
  const link = await makeLink();
  const other = await makeLink();

  // Frames sealed for `other` are presented to `link`.
  const wrong = new RawClient(other.record);
  await wrong.connect(link.port);
  wrong.write({ type: 'HELLO', sessionId: randomUUID(), lastSentSeq: 0, sentAt: Date.now() });

  await wrong.waitForClose();
  assert.equal(link.engine.status.state, 'IDLE');
  assert.equal(other.engine.status.state, 'IDLE');

  wrong.close();
  await link.close();
  await other.close();
});

test('a malformed frame closes the connection without touching state', async () => {
  const link = await makeLink();
  const raw = new RawClient(link.record);
  await raw.connect(link.port);

  raw.writeRaw(encodeFrame({ v: 1, deviceId: link.deviceId, nonce: 'AAAA', ct: '!!!', tag: 'xx' }));
  await raw.waitForClose();
  assert.equal(link.engine.status.state, 'IDLE');

  // An absurd length prefix is refused before anything is allocated for it.
  const raw2 = new RawClient(link.record);
  await raw2.connect(link.port);
  const bomb = Buffer.alloc(4);
  bomb.writeUInt32BE(0xffffffff, 0);
  raw2.writeRaw(bomb);
  await raw2.waitForClose();
  assert.equal(link.engine.status.state, 'IDLE');

  await link.close();
});

test('TIMEOUT and RECOVER cannot be injected by a controller', async () => {
  const link = await makeLink();
  const raw = new RawClient(link.record);
  await raw.connect(link.port);
  await raw.hello();

  const lock = raw.command({ type: 'LOCKDOWN' });
  raw.send(lock);
  const locked = (await raw.waitFor((m) => m.type === 'REPLY')) as ReplyFrame;
  const lockdownId = locked.result.lockdownId;

  // A controller must never be able to fabricate a fenced internal callback.
  for (const type of ['TIMEOUT', 'RECOVER'] as const) {
    raw.received.length = 0;
    raw.send(raw.command({ type, lockdownId }));
    const reject = (await raw.waitFor((m) => m.type === 'REJECT')) as RejectFrame;
    assert.equal(reject.code, 'FORBIDDEN_TYPE');
  }
  assert.equal(link.engine.status.state, 'LOCKED', 'still locked; the injections did nothing');

  raw.close();
  await link.close();
});

test('19. multiple paired phones are commanded independently', async () => {
  const phones = await Promise.all([
    makeLink({ label: 'phone-a' }),
    makeLink({ label: 'phone-b', adapter: { support: { cellular: 'UNSUPPORTED_BY_OS' } } }),
    makeLink({ label: 'phone-c' }),
  ]);

  const clock = new SystemClock();
  const clients = phones.map(
    (p) =>
      new ControllerClient({
        pairing: p.record,
        host: '127.0.0.1',
        port: p.port,
        // Separate state per phone, so no outbox or sequence space is shared.
        fs: new MemoryAtomicFs(),
        clock,
      }),
  );

  await Promise.all(clients.map((c) => c.start()));
  assert.deepEqual(await Promise.all(clients.map((c) => c.waitForReady(5_000))), [true, true, true]);

  // Lock A and C, leave B alone.
  const [a, c] = await Promise.all([clients[0]!.send('LOCKDOWN'), clients[2]!.send('LOCKDOWN')]);
  assert.equal(a.outcome, 'ACKED');
  assert.equal(c.outcome, 'ACKED');

  assert.equal(phones[0]!.engine.status.state, 'LOCKED');
  assert.equal(phones[1]!.engine.status.state, 'IDLE', 'B was never commanded');
  assert.equal(phones[2]!.engine.status.state, 'LOCKED');
  assert.equal(phones[1]!.adapter.deviceState.wifi.enabled, 'ON');

  // Each phone has its own lockdownId; one cannot restore another.
  const aId = phones[0]!.engine.status.activeLockdownId;
  const cId = phones[2]!.engine.status.activeLockdownId;
  assert.notEqual(aId, cId);

  const crossed = await clients[0]!.send('RESTORE', { lockdownId: cId });
  assert.equal(crossed.outcome, 'ACKED');
  if (crossed.outcome === 'ACKED') {
    assert.equal(crossed.result.status, 'IGNORED_STALE', "C's id must not restore A");
  }
  assert.equal(phones[0]!.engine.status.state, 'LOCKED', 'A is untouched');

  // B's own capability report differs and is respected independently.
  const bStatus = await clients[1]!.send('LOCKDOWN');
  assert.equal(bStatus.outcome, 'ACKED');
  if (bStatus.outcome === 'ACKED') {
    assert.equal(bStatus.result.results?.cellular.result, 'UNSUPPORTED');
    assert.equal(bStatus.result.results?.wifi.result, 'SUCCESS');
  }

  await Promise.all(clients.map((c2) => c2.stop()));
  await Promise.all(phones.map((p) => p.close()));
});

test('8/reconnect. a lockdown that kills the link is reconciled exactly once', async () => {
  // This is the real-world path: the controller sends LOCKDOWN, the phone
  // applies it, Wi-Fi goes away, and the reply never arrives.
  const link = await makeLink({ holdMs: 2_000 });
  const proxy = new CuttableProxy(link.port);
  const proxyPort = await proxy.listen();

  const events: string[] = [];
  const client = new ControllerClient({
    pairing: link.record,
    host: '127.0.0.1',
    port: proxyPort,
    fs: new MemoryAtomicFs(),
    clock: new SystemClock(),
    handshakeTimeoutMs: 800,
    onEvent: (e, d) => events.push(`${e}${d === undefined ? '' : ` ${d}`}`),
  });
  await client.start();
  assert.equal(await client.waitForReady(5_000), true);

  // Replies are swallowed and the link is cut right after the command lands.
  proxy.silenceReplies(true);
  const pending = client.send('LOCKDOWN', { ttlMs: 1_500 });
  await new Promise((r) => setTimeout(r, 300));
  proxy.cut();

  const outcome = await pending;
  assert.equal(outcome.outcome, 'UNCONFIRMED', 'the controller must not guess that it worked');

  // The phone, meanwhile, really did lock down.
  assert.equal(link.engine.status.state, 'LOCKED');
  const lockdownsApplied = link.adapter.calls.filter((c) => c.capability === 'wifi' && c.phase === 'lockdown');
  assert.equal(lockdownsApplied.length, 1);

  // The link comes back. The controller resumes and reconciles from facts.
  proxy.silenceReplies(false);
  assert.equal(await client.waitForReady(8_000), true);
  assert.ok(events.some((e) => e.startsWith('link.ready')), 'handshake completed again');

  // Still exactly one application: the resume did not re-apply anything.
  assert.equal(
    link.adapter.calls.filter((c) => c.capability === 'wifi' && c.phase === 'lockdown').length,
    1,
    'resume must never duplicate a side effect',
  );
  assert.deepEqual(client.outstanding, [], 'the outbox settled; nothing left dangling');

  // And the durable timer still restores on schedule, link or no link.
  await new Promise((r) => setTimeout(r, 2_600));
  assert.equal(link.engine.status.state, 'IDLE');
  assert.equal(link.adapter.deviceState.wifi.enabled, 'ON');

  await client.stop();
  await proxy.close();
  await link.close();
});
