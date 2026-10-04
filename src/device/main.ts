#!/usr/bin/env node
/**
 * Reference phone-side daemon.
 *
 * This is the desktop/Node realisation of the on-device service: identical
 * engine, store, protocol and audit log to what the Android service runs. It
 * exists so the whole system can be exercised and tested on a laptop before any
 * phone is involved, and so the semantics are pinned down by a runnable
 * implementation rather than by prose.
 *
 * Usage:
 *   netblock-daemon                     start the listener
 *   netblock-daemon pair --label NAME   mint a pairing code to type into the controller
 *   netblock-daemon status
 *   netblock-daemon release             clear every restriction this app authored
 */

import { AuditLog } from '../core/audit-log.ts';
import { SystemClock } from '../core/clock.ts';
import { NodeAtomicFs } from '../core/fs-port.ts';
import { RELEASE_REQUEST_FILE, stateDir } from '../core/paths.ts';
import { StateManager, DEFAULT_HOLD_MS } from '../core/state-manager.ts';
import { TransactionStore } from '../core/transaction-store.ts';
import { SimulatedConnectivityController } from '../adapters/simulated.ts';
import { PairingStore } from '../protocol/pairing-store.ts';
import { ReplayGuard } from '../protocol/replay-guard.ts';
import {
  encodePairingCode,
  fingerprint,
  generatePairingSecret,
  makePairingRecord,
} from '../protocol/pairing.ts';
import { DEFAULT_PORT } from '../protocol/session.ts';
import { DeviceServer } from './server.ts';
import { loadOrCreateIdentity } from './identity.ts';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'start';
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const dir = stateDir('device');
  const fs = new NodeAtomicFs(dir);
  const clock = new SystemClock();
  const identity = await loadOrCreateIdentity(fs, clock.now());

  const audit = new AuditLog(fs);
  const store = new TransactionStore(fs, identity.deviceId);
  // On a real phone this is AndroidConnectivityController over the Kotlin
  // bridge. On the desktop it is the simulator, so behaviour is observable.
  const adapter = new SimulatedConnectivityController();
  const engine = new StateManager({
    deviceId: identity.deviceId,
    adapter,
    store,
    audit,
    clock,
    holdMs: Number(flag('hold') ?? DEFAULT_HOLD_MS),
    // A second in-process timer behind the first, plus the OS alarm on Android.
    redundantAlarmMs: 5_000,
  });

  switch (command) {
    case 'pair': {
      const label = flag('label') ?? 'controller';
      const secret = generatePairingSecret();
      const pairings = new PairingStore(fs);
      await pairings.load();
      await pairings.upsert(makePairingRecord(identity.deviceId, label, secret, clock.now()));
      process.stdout.write(
        [
          '',
          'Pairing code (type this into the controller, once):',
          '',
          `    ${encodePairingCode(secret)}`,
          '',
          `Device id:   ${identity.deviceId}`,
          `Fingerprint: ${fingerprint(secret, identity.deviceId)}`,
          '',
          'Confirm the fingerprint matches on both ends before trusting the link.',
          'This code is the only secret. It is never sent over the network.',
          '',
        ].join('\n'),
      );
      return;
    }

    case 'status': {
      const status = await engine.init();
      process.stdout.write(`${JSON.stringify({ ...status, stateDir: dir }, null, 2)}\n`);
      const report = await adapter.getCapabilities();
      for (const entry of report.entries) {
        process.stdout.write(
          `${entry.capability.padEnd(14)} ${entry.support.padEnd(20)} ${entry.note}\n`,
        );
      }
      await engine.shutdown();
      return;
    }

    case 'release': {
      await engine.init();
      const status = await engine.release();
      process.stdout.write(`released; state=${status.state}\n`);
      await engine.shutdown();
      return;
    }

    case 'start': {
      await engine.init();
      const pairings = new PairingStore(fs);
      await pairings.load();
      if (pairings.all().length === 0) {
        process.stderr.write('No pairing on record. Run `pair` first.\n');
        process.exitCode = 1;
        return;
      }
      const replay = new ReplayGuard(fs);
      await replay.load();

      const server = new DeviceServer({
        deviceId: identity.deviceId,
        engine,
        pairings,
        replay,
        audit,
        clock,
        port: Number(flag('port') ?? DEFAULT_PORT),
        host: flag('host') ?? '0.0.0.0',
      });
      const bound = await server.listen();
      process.stdout.write(
        `netblock daemon listening on ${bound.host}:${String(bound.port)} as ${identity.deviceId}\n`,
      );

      // The offline escape hatch. A plain file, polled, so it works with no
      // network, no listener and no working UI.
      const releaseWatcher = setInterval(() => {
        void (async () => {
          if ((await fs.read(RELEASE_REQUEST_FILE)) === null) return;
          await fs.writeAtomic(RELEASE_REQUEST_FILE, '');
          const status = await engine.release();
          process.stdout.write(`release requested locally; state=${status.state}\n`);
        })().catch(() => undefined);
      }, 1_000);
      releaseWatcher.unref?.();

      const shutdown = async (): Promise<void> => {
        clearInterval(releaseWatcher);
        await server.close();
        await engine.shutdown();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
      return;
    }

    default: {
      process.stderr.write(`unknown command: ${command}\n`);
      process.exitCode = 1;
    }
  }
}

void main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
