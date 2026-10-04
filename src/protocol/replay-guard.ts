/**
 * Replay, reorder and expiry defence for inbound commands.
 *
 * Four independent checks, each of which alone would stop some attacks and none
 * of which is trusted on its own:
 *
 *  1. Expiry       — the command carries its own `expiresAt`.
 *  2. Clock window — `timestamp` must be within an allowed skew of now.
 *  3. Sequence     — `seq` must advance; an older seq is a delayed or
 *                    reordered frame and is dropped.
 *  4. Identity     — `commandId` must not have been seen before.
 *
 * The seen-set and the high-water sequence are persisted, so a restart does not
 * reopen a replay window. The seen-set is bounded.
 */

import type { AtomicFs } from '../core/fs-port.ts';

const KEY = 'replay.json';
export const DEFAULT_SEEN_LIMIT = 256;
export const DEFAULT_SKEW_MS = 120_000;

export type ReplayVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly code: ReplayRejection };

export type ReplayRejection =
  | 'EXPIRED'
  | 'CLOCK_SKEW'
  | 'OUT_OF_ORDER'
  | 'DUPLICATE'
  | 'MALFORMED';

type Persisted = {
  readonly highestSeq: number;
  readonly seen: readonly string[];
  readonly sendCounter: string;
};

export class ReplayGuard {
  readonly #fs: AtomicFs;
  readonly #limit: number;
  readonly #skewMs: number;
  #highestSeq = 0;
  #seen: string[] = [];
  #sendCounter = 0n;
  #tail: Promise<void> = Promise.resolve();

  constructor(fs: AtomicFs, limit = DEFAULT_SEEN_LIMIT, skewMs = DEFAULT_SKEW_MS) {
    this.#fs = fs;
    this.#limit = Math.max(8, limit);
    this.#skewMs = skewMs;
  }

  async load(): Promise<void> {
    const raw = await this.#fs.read(KEY);
    if (raw === null) return;
    try {
      const parsed = JSON.parse(raw) as Persisted;
      this.#highestSeq = typeof parsed.highestSeq === 'number' ? parsed.highestSeq : 0;
      this.#seen = Array.isArray(parsed.seen) ? parsed.seen.slice(-this.#limit) : [];
      this.#sendCounter = BigInt(parsed.sendCounter ?? '0');
    } catch {
      // Unreadable replay state fails closed: start from a clean, strict window
      // rather than trusting partially parsed values.
      this.#highestSeq = 0;
      this.#seen = [];
      this.#sendCounter = 0n;
    }
  }

  get highestSeq(): number {
    return this.#highestSeq;
  }

  get sendCounter(): bigint {
    return this.#sendCounter;
  }

  /**
   * Reserve a block of nonce counter values before any are used, so a crash
   * cannot cause a counter value to be reused after restart.
   */
  async reserveSendCounter(block = 1024n): Promise<bigint> {
    const start = this.#sendCounter;
    this.#sendCounter = start + block;
    await this.#persist();
    return start;
  }

  /** Check a command. Call `accept` only once it has actually been processed. */
  check(params: { commandId: string; seq: number; timestamp: number; expiresAt: number; now: number }): ReplayVerdict {
    const { commandId, seq, timestamp, expiresAt, now } = params;

    if (typeof commandId !== 'string' || commandId.length === 0 || commandId.length > 128) {
      return { ok: false, code: 'MALFORMED', reason: 'bad commandId' };
    }
    if (!Number.isFinite(seq) || !Number.isInteger(seq) || seq <= 0) {
      return { ok: false, code: 'MALFORMED', reason: 'bad seq' };
    }
    if (!Number.isFinite(timestamp) || !Number.isFinite(expiresAt)) {
      return { ok: false, code: 'MALFORMED', reason: 'bad timing fields' };
    }
    if (expiresAt <= now) {
      return { ok: false, code: 'EXPIRED', reason: 'command expired' };
    }
    if (Math.abs(now - timestamp) > this.#skewMs) {
      return { ok: false, code: 'CLOCK_SKEW', reason: 'timestamp outside accepted window' };
    }
    if (this.#seen.includes(commandId)) {
      // A duplicate is reported distinctly: the caller replies with the cached
      // result so an honest retry still gets its answer.
      return { ok: false, code: 'DUPLICATE', reason: 'commandId already processed' };
    }
    if (seq <= this.#highestSeq) {
      return { ok: false, code: 'OUT_OF_ORDER', reason: `seq ${seq} not newer than ${this.#highestSeq}` };
    }
    return { ok: true };
  }

  /** Record a command as processed. Durable before the reply is sent. */
  async accept(commandId: string, seq: number): Promise<void> {
    this.#highestSeq = Math.max(this.#highestSeq, seq);
    this.#seen.push(commandId);
    if (this.#seen.length > this.#limit) this.#seen = this.#seen.slice(-this.#limit);
    await this.#persist();
  }

  has(commandId: string): boolean {
    return this.#seen.includes(commandId);
  }

  #persist(): Promise<void> {
    const payload: Persisted = {
      highestSeq: this.#highestSeq,
      seen: [...this.#seen],
      sendCounter: this.#sendCounter.toString(),
    };
    const data = JSON.stringify(payload);
    this.#tail = this.#tail.then(() => this.#fs.writeAtomic(KEY, data).catch(() => undefined));
    return this.#tail;
  }
}
