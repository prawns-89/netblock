/**
 * Bounded, redacted audit log.
 *
 * Entries are assembled field-by-field from a fixed schema and every string is
 * sanitised before it is stored, so the log cannot accumulate SSIDs, keys,
 * message content, file paths or other personal data even if a caller passes
 * something careless. The log is a ring buffer with a hard entry cap, so it
 * cannot grow without bound.
 */

import type { AtomicFs } from './fs-port.ts';
import type { AuditEntry } from './types.ts';

const AUDIT_KEY = 'audit.json';
export const DEFAULT_AUDIT_CAPACITY = 500;
const MAX_FIELD_LENGTH = 200;

/**
 * Patterns that must never reach the log. Anything matching is dropped rather
 * than truncated, because a partial secret is still a secret.
 */
const FORBIDDEN = [
  /\bpassw/i,
  /\bpasskey\b/i,
  /\bpsk\b/i,
  /\bssid\b/i,
  /\bpre-?shared\b/i,
  /\bimsi\b/i,
  /\biccid\b/i,
  /\bimei\b/i,
  /\bsecret\b/i,
  /\btoken\b/i,
  /\bprivate[-_ ]?key\b/i,
  /\bWPA[0-9]?\b/,
  /[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}/, // MAC address
];

export function sanitizeField(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const collapsed = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  if (FORBIDDEN.some((re) => re.test(collapsed))) return '[redacted]';
  return collapsed.slice(0, MAX_FIELD_LENGTH);
}

export type AuditInput = {
  readonly timestamp: number;
  readonly deviceId: string;
  readonly lockdownId?: string | null;
  readonly commandId?: string | null;
  readonly operation: string;
  readonly previousState?: string | null;
  readonly requestedState?: string | null;
  readonly result: string;
  readonly error?: string | null;
};

export class AuditLog {
  readonly #fs: AtomicFs;
  readonly #capacity: number;
  #entries: AuditEntry[] = [];
  #loaded = false;
  /** Serialises log writes so concurrent appends cannot interleave. */
  #tail: Promise<void> = Promise.resolve();

  constructor(fs: AtomicFs, capacity: number = DEFAULT_AUDIT_CAPACITY) {
    this.#fs = fs;
    this.#capacity = Math.max(1, capacity);
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    const raw = await this.#fs.read(AUDIT_KEY);
    if (raw === null) return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      // A damaged audit log is discarded, never trusted and never allowed to
      // block the lockdown engine: it is diagnostic data, not state.
      this.#entries = Array.isArray(parsed) ? (parsed.slice(-this.#capacity) as AuditEntry[]) : [];
    } catch {
      this.#entries = [];
    }
  }

  append(input: AuditInput): Promise<void> {
    const entry: AuditEntry = {
      timestamp: input.timestamp,
      deviceId: sanitizeField(input.deviceId) ?? 'unknown',
      lockdownId: sanitizeField(input.lockdownId),
      commandId: sanitizeField(input.commandId),
      operation: sanitizeField(input.operation) ?? 'unknown',
      previousState: sanitizeField(input.previousState),
      requestedState: sanitizeField(input.requestedState),
      result: sanitizeField(input.result) ?? 'unknown',
      error: sanitizeField(input.error),
    };

    this.#entries.push(entry);
    if (this.#entries.length > this.#capacity) {
      this.#entries = this.#entries.slice(-this.#capacity);
    }

    const snapshot = JSON.stringify(this.#entries);
    this.#tail = this.#tail.then(async () => {
      // A failed audit write must never fail the lockdown transaction.
      await this.#fs.writeAtomic(AUDIT_KEY, snapshot).catch(() => undefined);
    });
    return this.#tail;
  }

  async flush(): Promise<void> {
    await this.#tail;
  }

  entries(): readonly AuditEntry[] {
    return [...this.#entries];
  }

  get size(): number {
    return this.#entries.length;
  }

  get capacity(): number {
    return this.#capacity;
  }
}
