/** Stable, non-personal device identity. Generated once, then persisted. */

import { randomUUID } from 'node:crypto';

import type { AtomicFs } from '../core/fs-port.ts';

const KEY = 'identity.json';

export type Identity = {
  readonly deviceId: string;
  readonly createdAt: number;
};

/**
 * The id is a random UUID, never a hardware identifier: it must not be a
 * fingerprint of the phone, and nothing in the system needs it to be.
 */
export async function loadOrCreateIdentity(fs: AtomicFs, now: number): Promise<Identity> {
  const raw = await fs.read(KEY);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Identity;
      if (typeof parsed.deviceId === 'string' && parsed.deviceId.length > 0) return parsed;
    } catch {
      // fall through and mint a new identity
    }
  }
  const identity: Identity = { deviceId: randomUUID(), createdAt: now };
  await fs.writeAtomic(KEY, JSON.stringify(identity));
  return identity;
}
