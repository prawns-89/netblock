/**
 * Durable transaction store.
 *
 * Two slots (A/B) are written alternately. A commit always targets the slot that
 * does *not* currently hold the newest valid record, so the previous valid
 * record — and therefore the previous valid snapshot — stays readable until the
 * new one is fully durable. Every record carries a CRC-32 over its canonical
 * payload, so a torn write is detected rather than trusted.
 */

import type { AtomicFs } from './fs-port.ts';
import { crc32Hex } from './crc32.ts';
import type { TransactionRecord } from './types.ts';
import { initialRecord } from './types.ts';

const SLOT_A = 'txn.a.json';
const SLOT_B = 'txn.b.json';

/** Keep the exactly-once command cache from growing without bound. */
export const COMMAND_LOG_LIMIT = 64;

export type Integrity =
  /** Nothing persisted yet: first run. */
  | 'EMPTY'
  /** At least one slot read cleanly and it is the newest. */
  | 'OK'
  /** The newest slot was unreadable; the previous valid record was used instead. */
  | 'RECOVERED_FROM_PREVIOUS'
  /** Records exist but none validate. The engine must not trust any state. */
  | 'BOTH_CORRUPT';

export type LoadResult = {
  readonly record: TransactionRecord | null;
  readonly integrity: Integrity;
  readonly detail?: string;
};

type Envelope = {
  readonly crc: string;
  readonly payload: string;
};

export class TransactionStore {
  readonly #fs: AtomicFs;
  readonly #deviceId: string;
  /** Slot holding the newest valid record; the next commit targets the other. */
  #newestSlot: typeof SLOT_A | typeof SLOT_B | null = null;
  #lastSeq = 0;

  constructor(fs: AtomicFs, deviceId: string) {
    this.#fs = fs;
    this.#deviceId = deviceId;
  }

  async #readSlot(slot: string): Promise<{ record: TransactionRecord; raw: string } | null> {
    const raw = await this.#fs.read(slot);
    if (raw === null) return null;
    try {
      const env = JSON.parse(raw) as Envelope;
      if (typeof env.crc !== 'string' || typeof env.payload !== 'string') return null;
      if (crc32Hex(env.payload) !== env.crc) return null;
      const record = JSON.parse(env.payload) as TransactionRecord;
      if (record.schemaVersion !== 1) return null;
      if (typeof record.seq !== 'number' || !Number.isFinite(record.seq)) return null;
      if (record.deviceId !== this.#deviceId) return null;
      return { record, raw };
    } catch {
      return null; // unparseable == corrupt == untrusted
    }
  }

  async load(): Promise<LoadResult> {
    const [a, b] = await Promise.all([this.#readSlot(SLOT_A), this.#readSlot(SLOT_B)]);
    const rawA = await this.#fs.read(SLOT_A);
    const rawB = await this.#fs.read(SLOT_B);
    const anyBytes = rawA !== null || rawB !== null;

    if (a === null && b === null) {
      if (!anyBytes) {
        this.#newestSlot = null;
        this.#lastSeq = 0;
        return { record: null, integrity: 'EMPTY' };
      }
      return {
        record: null,
        integrity: 'BOTH_CORRUPT',
        detail: 'no transaction slot passed CRC validation',
      };
    }

    const pick =
      a !== null && b !== null
        ? a.record.seq >= b.record.seq
          ? { slot: SLOT_A, hit: a }
          : { slot: SLOT_B, hit: b }
        : a !== null
          ? { slot: SLOT_A, hit: a }
          : { slot: SLOT_B, hit: b! };

    this.#newestSlot = pick.slot as typeof SLOT_A | typeof SLOT_B;
    this.#lastSeq = pick.hit.record.seq;

    const oneCorrupt = (a === null && rawA !== null) || (b === null && rawB !== null);
    return {
      record: pick.hit.record,
      integrity: oneCorrupt ? 'RECOVERED_FROM_PREVIOUS' : 'OK',
      ...(oneCorrupt ? { detail: 'one slot failed CRC; fell back to the previous valid record' } : {}),
    };
  }

  /**
   * Durably commit `record`. On success the record is readable; on failure the
   * previously committed record is still readable and unchanged.
   */
  async commit(record: TransactionRecord): Promise<TransactionRecord> {
    const next: TransactionRecord = {
      ...record,
      schemaVersion: 1,
      deviceId: this.#deviceId,
      seq: this.#lastSeq + 1,
      commandLog: record.commandLog.slice(-COMMAND_LOG_LIMIT),
    };

    // Target the slot that is NOT currently newest, so the previous valid
    // record survives a failed or torn write.
    const target = this.#newestSlot === SLOT_A ? SLOT_B : SLOT_A;

    const payload = JSON.stringify(next);
    const envelope: Envelope = { crc: crc32Hex(payload), payload };
    await this.#fs.writeAtomic(target, JSON.stringify(envelope));

    this.#newestSlot = target;
    this.#lastSeq = next.seq;
    return next;
  }

  /** Flush pending writes. Called before any connectivity change. */
  async checkpoint(): Promise<void> {
    await this.#fs.checkpoint();
  }

  /** A clean IDLE record for this device, used on first run. */
  fresh(): TransactionRecord {
    return initialRecord(this.#deviceId);
  }
}
