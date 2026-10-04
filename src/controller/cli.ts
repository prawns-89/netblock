#!/usr/bin/env node
/**
 * Controller CLI. Runs on Linux, Windows and macOS with no dependencies
 * beyond Node itself.
 *
 *   netblock pair --host 192.168.1.42 --device <id> [--label NAME] [--port N]
 *   netblock devices
 *   netblock lock    [--device <id>|--all]
 *   netblock restore [--device <id>|--all]
 *   netblock toggle  [--device <id>|--all]
 *   netblock status  [--device <id>|--all]
 *   netblock unpair  --device <id>
 *
 * Each paired phone is contacted over its own independent client, with its own
 * keys, its own outbox and its own sequence space, so one phone being offline
 * or mid-lockdown never affects another.
 */

import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { SystemClock } from '../core/clock.ts';
import { NodeAtomicFs } from '../core/fs-port.ts';
import { stateDir } from '../core/paths.ts';
import type { CommandType } from '../core/types.ts';
import {
  decodePairingCode,
  fingerprint,
  makePairingRecord,
  type PairingRecord,
} from '../protocol/pairing.ts';
import { PairingStore } from '../protocol/pairing-store.ts';
import { DEFAULT_PORT } from '../protocol/session.ts';
import { ControllerClient, type SendOutcome } from './client.ts';

type Endpoints = Record<string, { host: string; port: number }>;
const ENDPOINTS_KEY = 'endpoints.json';

const clock = new SystemClock();
const fs = new NodeAtomicFs(stateDir('controller'));

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function has(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

async function loadEndpoints(): Promise<Endpoints> {
  const raw = await fs.read(ENDPOINTS_KEY);
  if (raw === null) return {};
  try {
    return JSON.parse(raw) as Endpoints;
  } catch {
    return {};
  }
}

async function saveEndpoint(deviceId: string, host: string, port: number): Promise<void> {
  const endpoints = await loadEndpoints();
  endpoints[deviceId] = { host, port };
  await fs.writeAtomic(ENDPOINTS_KEY, JSON.stringify(endpoints, null, 2));
}

async function selectDevices(argv: string[], pairings: PairingStore): Promise<PairingRecord[]> {
  const all = pairings.all();
  if (has(argv, 'all')) return [...all];
  const wanted = flag(argv, 'device');
  if (wanted !== undefined) {
    const found = all.find((p) => p.deviceId === wanted || p.deviceId.startsWith(wanted));
    if (found === undefined) throw new Error(`no pairing for device ${wanted}`);
    return [found];
  }
  if (all.length === 1) return [all[0]!];
  throw new Error(
    all.length === 0
      ? 'no paired devices; run `netblock pair` first'
      : 'several devices are paired; pass --device <id> or --all',
  );
}

function describe(outcome: SendOutcome): string {
  switch (outcome.outcome) {
    case 'ACKED': {
      const r = outcome.result;
      const parts = [r.status === 'STATUS_OK' ? `state=${r.state}` : r.status];
      if (r.status === 'STATUS_OK' && r.lockdownId !== null) {
        parts.push(`lockdown=${r.lockdownId.slice(0, 8)}`);
      }
      if (r.restoreDeadline != null) {
        const left = Math.max(0, Math.round((r.restoreDeadline - clock.now()) / 1000));
        parts.push(`restore in ~${String(left)}s`);
      }
      if (r.detail !== undefined) parts.push(`(${r.detail})`);
      if (r.results !== undefined && r.results !== null && r.status !== 'STATUS_OK') {
        const table = Object.entries(r.results)
          .map(([k, v]) => `${k}=${v.result}`)
          .join(' ');
        parts.push(`\n  ${table}`);
      }
      return parts.join(' ');
    }
    case 'REJECTED':
      return `REJECTED ${outcome.code}: ${outcome.reason}`;
    case 'UNCONFIRMED':
      return `UNCONFIRMED — ${outcome.detail}`;
  }
}

async function runOn(record: PairingRecord, type: CommandType, argv: string[]): Promise<void> {
  const endpoints = await loadEndpoints();
  const endpoint = endpoints[record.deviceId];
  const host = flag(argv, 'host') ?? endpoint?.host;
  const port = Number(flag(argv, 'port') ?? endpoint?.port ?? DEFAULT_PORT);
  if (host === undefined) throw new Error(`no address on record for ${record.deviceId}; pass --host`);

  const verbose = has(argv, 'verbose');
  const client = new ControllerClient({
    pairing: record,
    host,
    port,
    fs,
    clock,
    onEvent: verbose ? (e, d) => stdout.write(`  · ${e}${d === undefined ? '' : ` ${d}`}\n`) : undefined,
  });

  await client.start();
  const ready = await client.waitForReady(8_000);
  if (!ready) {
    const diagnosis = client.diagnosis;
    stdout.write(
      diagnosis === null
        ? `${record.label} (${record.deviceId.slice(0, 8)}): unreachable at ${host}:${String(port)}\n`
        : `${record.label} (${record.deviceId.slice(0, 8)}): ${diagnosis}\n`,
    );
    await client.stop();
    process.exitCode = 1;
    return;
  }

  const view = client.deviceView;
  const lockdownId = type === 'RESTORE' ? (view?.lockdownId ?? null) : null;
  const outcome = await client.send(type, { lockdownId });

  stdout.write(`${record.label} (${record.deviceId.slice(0, 8)}): ${describe(outcome)}\n`);

  if (outcome.outcome === 'ACKED' && outcome.result.status === 'LOCKED') {
    const deadline = outcome.result.restoreDeadline;
    if (deadline != null) {
      const seconds = Math.round((deadline - clock.now()) / 1000);
      // Printed on the controller only. The phone shows nothing.
      stdout.write(`  automatic restore in ~${String(seconds)}s (durable; survives reboot)\n`);
    }
    stdout.write('  the link is expected to drop now: lockdown disables the Wi-Fi it travelled over\n');
  }
  if (outcome.outcome === 'UNCONFIRMED') {
    stdout.write('  the outbox will reconcile this against the device on the next reconnect\n');
  }

  await client.stop();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'help';
  const pairings = new PairingStore(fs);
  await pairings.load();

  switch (command) {
    case 'pair': {
      const host = flag(argv, 'host');
      const deviceId = flag(argv, 'device');
      const port = Number(flag(argv, 'port') ?? DEFAULT_PORT);
      if (host === undefined || deviceId === undefined) {
        throw new Error('pair requires --host <ip> and --device <id> (both printed by the phone)');
      }
      const rl = readline.createInterface({ input: stdin, output: stdout });
      try {
        const code = flag(argv, 'code') ?? (await rl.question('Pairing code from the phone: '));
        const secret = decodePairingCode(code);
        const fp = fingerprint(secret, deviceId);
        stdout.write(`\nFingerprint: ${fp}\n`);
        const confirm = await rl.question('Does this match the fingerprint shown on the phone? [y/N] ');
        if (confirm.trim().toLowerCase() !== 'y') {
          stdout.write('Pairing abandoned. Nothing was stored.\n');
          return;
        }
        const label = flag(argv, 'label') ?? (await rl.question('Label for this phone: '));
        await pairings.upsert(makePairingRecord(deviceId, label || 'phone', secret, clock.now()));
        await saveEndpoint(deviceId, host, port);
        stdout.write(`\nPaired "${label}" at ${host}:${String(port)}.\n`);
      } finally {
        rl.close();
      }
      return;
    }

    case 'devices': {
      const all = pairings.all();
      if (all.length === 0) {
        stdout.write('No paired devices.\n');
        return;
      }
      const endpoints = await loadEndpoints();
      for (const p of all) {
        const e = endpoints[p.deviceId];
        stdout.write(
          `${p.label.padEnd(20)} ${p.deviceId}  ${e === undefined ? '(no address)' : `${e.host}:${String(e.port)}`}\n` +
            `${''.padEnd(20)} fingerprint ${p.fingerprint}\n`,
        );
      }
      return;
    }

    case 'unpair': {
      const deviceId = flag(argv, 'device');
      if (deviceId === undefined) throw new Error('unpair requires --device <id>');
      const removed = await pairings.remove(deviceId);
      stdout.write(removed ? 'Pairing removed.\n' : 'No such pairing.\n');
      return;
    }

    case 'lock':
    case 'restore':
    case 'toggle':
    case 'status': {
      const type: CommandType =
        command === 'lock'
          ? 'LOCKDOWN'
          : command === 'restore'
            ? 'RESTORE'
            : command === 'toggle'
              ? 'TOGGLE'
              : 'STATUS';
      const targets = await selectDevices(argv, pairings);
      // Independent clients, run concurrently. Each phone's engine serialises
      // its own commands; nothing is shared between devices.
      await Promise.all(targets.map((t) => runOn(t, type, argv).catch((err: unknown) => {
        stdout.write(`${t.label}: ${err instanceof Error ? err.message : String(err)}\n`);
      })));
      return;
    }

    default: {
      stdout.write(
        [
          'netblock — connectivity lockdown for your own paired phones',
          '',
          '  pair --host <ip> --device <id> [--label NAME] [--port N]',
          '  devices',
          '  lock    [--device <id>|--all] [--verbose]',
          '  restore [--device <id>|--all]',
          '  toggle  [--device <id>|--all]',
          '  status  [--device <id>|--all]',
          '  unpair  --device <id>',
          '',
          `  state directory: ${stateDir('controller')}`,
          '',
        ].join('\n'),
      );
    }
  }
}

void main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
