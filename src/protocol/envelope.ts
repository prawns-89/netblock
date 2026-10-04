/**
 * Authenticated encrypted command envelopes (AES-256-GCM).
 *
 * The entire command is encrypted; only the protocol version, the device id
 * (needed to select a key when several phones are paired) and the nonce travel
 * in the clear, and all three are bound as additional authenticated data, so
 * neither can be altered without the tag failing.
 *
 * Nonce construction is a persisted monotonic counter in the high 8 bytes plus
 * 4 random bytes. The counter guarantees uniqueness per key even if the random
 * source were poor; the random tail guarantees it even if a counter write were
 * lost. Nonce reuse under GCM is catastrophic, so neither mechanism is trusted
 * alone.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { Command, CommandResult } from '../core/types.ts';
import { PROTOCOL_VERSION } from './pairing.ts';

const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Reject anything larger before attempting to decrypt it. */
export const MAX_FRAME_BYTES = 64 * 1024;

export type Envelope = {
  readonly v: number;
  readonly deviceId: string;
  /** base64, 12 bytes. */
  readonly nonce: string;
  /** base64 ciphertext. */
  readonly ct: string;
  /** base64 GCM tag. */
  readonly tag: string;
};

export class NonceSource {
  #counter: bigint;

  constructor(startCounter: bigint = 0n) {
    this.#counter = startCounter;
  }

  get counter(): bigint {
    return this.#counter;
  }

  next(): Buffer {
    this.#counter += 1n;
    const nonce = Buffer.alloc(IV_BYTES);
    nonce.writeBigUInt64BE(this.#counter, 0);
    randomBytes(4).copy(nonce, 8);
    return nonce;
  }
}

function aad(version: number, deviceId: string, nonce: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`netblock/v${version}/`, 'utf8'),
    Buffer.from(deviceId, 'utf8'),
    Buffer.from([0]),
    nonce,
  ]);
}

export function seal(payload: unknown, key: Buffer, deviceId: string, nonce: Buffer): Envelope {
  if (nonce.length !== IV_BYTES) throw new Error('nonce must be 12 bytes');
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(PROTOCOL_VERSION, deviceId, nonce));
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    v: PROTOCOL_VERSION,
    deviceId,
    nonce: nonce.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export type OpenResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export function open<T>(envelope: unknown, key: Buffer, expectDeviceId: string): OpenResult<T> {
  if (typeof envelope !== 'object' || envelope === null) {
    return { ok: false, reason: 'envelope is not an object' };
  }
  const env = envelope as Partial<Envelope>;

  if (env.v !== PROTOCOL_VERSION) return { ok: false, reason: `unsupported version ${String(env.v)}` };
  if (typeof env.deviceId !== 'string' || env.deviceId.length === 0) {
    return { ok: false, reason: 'missing deviceId' };
  }
  if (env.deviceId !== expectDeviceId) return { ok: false, reason: 'envelope addressed to another device' };
  if (typeof env.nonce !== 'string' || typeof env.ct !== 'string' || typeof env.tag !== 'string') {
    return { ok: false, reason: 'malformed envelope fields' };
  }

  let nonce: Buffer;
  let ct: Buffer;
  let tag: Buffer;
  try {
    nonce = Buffer.from(env.nonce, 'base64');
    ct = Buffer.from(env.ct, 'base64');
    tag = Buffer.from(env.tag, 'base64');
  } catch {
    return { ok: false, reason: 'base64 decode failed' };
  }
  if (nonce.length !== IV_BYTES) return { ok: false, reason: 'bad nonce length' };
  if (tag.length !== TAG_BYTES) return { ok: false, reason: 'bad tag length' };
  if (ct.length > MAX_FRAME_BYTES) return { ok: false, reason: 'ciphertext too large' };

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(PROTOCOL_VERSION, env.deviceId, nonce));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    return { ok: true, value: JSON.parse(plain) as T };
  } catch {
    // Authentication failure and malformed plaintext are deliberately
    // indistinguishable to a caller, and nothing about the key is revealed.
    return { ok: false, reason: 'authentication failed' };
  }
}

/** Wire form of a command, carrying every field the protocol requires. */
export type CommandPayload = Command & {
  /** Strictly increasing per pairing. Detects reordering and delayed frames. */
  readonly seq: number;
};

export type ReplyPayload = {
  readonly inReplyTo: string;
  readonly seq: number;
  readonly result: CommandResult;
};
