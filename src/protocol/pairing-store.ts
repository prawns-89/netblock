/**
 * Persisted pairings. Only explicitly paired devices exist as far as the rest
 * of the system is concerned: there is no discovery, no broadcast enrolment and
 * no code path that can add a peer without the owner transcribing a secret.
 */

import type { AtomicFs } from '../core/fs-port.ts';
import type { PairingRecord } from './pairing.ts';

const KEY = 'pairings.json';

export class PairingStore {
  readonly #fs: AtomicFs;
  #records: PairingRecord[] = [];
  #loaded = false;

  constructor(fs: AtomicFs) {
    this.#fs = fs;
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    const raw = await this.#fs.read(KEY);
    if (raw === null) return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      this.#records = Array.isArray(parsed) ? (parsed as PairingRecord[]) : [];
    } catch {
      // Fail closed: an unreadable pairing file means no peer is trusted.
      this.#records = [];
    }
  }

  all(): readonly PairingRecord[] {
    return [...this.#records];
  }

  find(deviceId: string): PairingRecord | null {
    return this.#records.find((r) => r.deviceId === deviceId) ?? null;
  }

  async upsert(record: PairingRecord): Promise<void> {
    this.#records = [...this.#records.filter((r) => r.deviceId !== record.deviceId), record];
    await this.#persist();
  }

  async remove(deviceId: string): Promise<boolean> {
    const before = this.#records.length;
    this.#records = this.#records.filter((r) => r.deviceId !== deviceId);
    if (this.#records.length === before) return false;
    await this.#persist();
    return true;
  }

  async #persist(): Promise<void> {
    await this.#fs.writeAtomic(KEY, JSON.stringify(this.#records));
  }
}
