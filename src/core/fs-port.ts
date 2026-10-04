/**
 * Filesystem port. Abstracted so tests can inject power-loss faults at the
 * exact instants that matter (mid-temp-write, and post-rename torn content).
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** Directory fsync is a POSIX concept; on Windows the rename is durable without it. */
const DIR_FSYNC_SUPPORTED = os.platform() !== 'win32';

export interface AtomicFs {
  /** Returns null when the key does not exist. */
  read(key: string): Promise<string | null>;
  /**
   * Durably replace `key`. Must be all-or-nothing from a reader's perspective:
   * write to a temp name, flush it, then rename over the target.
   */
  writeAtomic(key: string, data: string): Promise<void>;
  /** Flush any buffered writes. Called before connectivity is touched. */
  checkpoint(): Promise<void>;
}

/** Real filesystem: temp file -> fsync(file) -> rename -> fsync(dir). */
export class NodeAtomicFs implements AtomicFs {
  readonly #dir: string;
  #ready: Promise<void> | null = null;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async #ensureDir(): Promise<void> {
    this.#ready ??= fs.mkdir(this.#dir, { recursive: true, mode: 0o700 }).then(() => undefined);
    await this.#ready;
  }

  async read(key: string): Promise<string | null> {
    try {
      return await fs.readFile(path.join(this.#dir, key), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async writeAtomic(key: string, data: string): Promise<void> {
    await this.#ensureDir();
    const target = path.join(this.#dir, key);
    const tmp = path.join(this.#dir, `.${key}.${randomUUID()}.tmp`);

    const handle = await fs.open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync(); // data durable before it is reachable under the real name
    } finally {
      await handle.close();
    }

    // ReplaceFile/MoveFileEx on Windows and rename(2) on POSIX both replace
    // the target atomically for readers.
    await fs.rename(tmp, target);
    await this.#syncDir();
  }

  async checkpoint(): Promise<void> {
    await this.#ensureDir();
    await this.#syncDir();
  }

  /** fsync the directory so the rename itself survives power loss. */
  async #syncDir(): Promise<void> {
    if (!DIR_FSYNC_SUPPORTED) return;
    let dirHandle;
    try {
      dirHandle = await fs.open(this.#dir, 'r');
      await dirHandle.sync();
    } catch {
      // Some filesystems refuse fsync on a directory handle. The rename is
      // still atomic; only its durability point is less precise.
    } finally {
      await dirHandle?.close();
    }
  }
}

export type FaultMode =
  /** Throw before the rename. The previous content must remain fully intact. */
  | 'before-commit'
  /** Rename lands, but only a prefix of the bytes made it to stable storage. */
  | 'torn-after-commit';

/** In-memory filesystem with deterministic fault injection. */
export class MemoryAtomicFs implements AtomicFs {
  readonly #files = new Map<string, string>();
  #fault: { mode: FaultMode; key?: string } | null = null;
  #writes = 0;
  #checkpoints = 0;

  /** Arm a one-shot fault for the next writeAtomic (optionally only for `key`). */
  armFault(mode: FaultMode, key?: string): void {
    this.#fault = key === undefined ? { mode } : { mode, key };
  }

  clearFault(): void {
    this.#fault = null;
  }

  get writeCount(): number {
    return this.#writes;
  }

  get checkpointCount(): number {
    return this.#checkpoints;
  }

  snapshotFiles(): Map<string, string> {
    return new Map(this.#files);
  }

  restoreFiles(files: Map<string, string>): void {
    this.#files.clear();
    for (const [k, v] of files) this.#files.set(k, v);
  }

  /** Overwrite raw bytes, bypassing atomicity. Used to simulate bit rot. */
  corrupt(key: string, data: string): void {
    this.#files.set(key, data);
  }

  async read(key: string): Promise<string | null> {
    return this.#files.get(key) ?? null;
  }

  async writeAtomic(key: string, data: string): Promise<void> {
    this.#writes++;
    const fault = this.#fault;
    if (fault !== null && (fault.key === undefined || fault.key === key)) {
      this.#fault = null;
      if (fault.mode === 'before-commit') {
        // Temp file was being written when power was lost: target untouched.
        throw new Error('simulated power loss before commit');
      }
      // Rename completed but the tail of the data never reached stable storage.
      this.#files.set(key, data.slice(0, Math.max(1, Math.floor(data.length * 0.6))));
      throw new Error('simulated power loss after commit (torn write)');
    }
    this.#files.set(key, data);
  }

  async checkpoint(): Promise<void> {
    this.#checkpoints++;
  }
}
