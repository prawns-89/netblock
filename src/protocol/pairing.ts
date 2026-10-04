/**
 * Pairing.
 *
 * Deliberately dependency-free and server-free. The phone generates a 160-bit
 * random pairing secret once and displays it as 32 Crockford base32 characters;
 * the owner types it into the controller. Both sides derive directional keys
 * with HKDF-SHA256. There is no key exchange over the network, so there is
 * nothing for a network attacker to interpose on, and no third party is
 * involved at any point.
 *
 * Why a typed secret rather than ECDH: X25519 is only available in Android's
 * JCA from API 33, and the requirement is that no dependency can wedge the
 * system. A 160-bit pre-shared secret plus HKDF and AES-GCM uses nothing beyond
 * what every supported Android version and every Node version already ship.
 */

import { createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** Crockford base32 without I, L, O, U, so transcription is unambiguous. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SECRET_BYTES = 20; // 160 bits
export const PROTOCOL_VERSION = 1;

export type PairingRecord = {
  readonly version: number;
  readonly deviceId: string;
  /** Owner-facing label. Never contains anything beyond what the owner typed. */
  readonly label: string;
  /** Base64 of the shared secret. Stored only on the two paired endpoints. */
  readonly secret: string;
  readonly createdAt: number;
  /** Short digest both sides display so the owner can confirm they match. */
  readonly fingerprint: string;
};

export type DirectionalKeys = {
  readonly controllerToDevice: Buffer;
  readonly deviceToController: Buffer;
};

export function generatePairingSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

export function encodePairingCode(secret: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of secret) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out.replace(/(.{4})/g, '$1-').replace(/-$/, '');
}

export function decodePairingCode(code: string): Buffer {
  const cleaned = code
    .toUpperCase()
    .replace(/[\s-]/g, '')
    // Accept the characters the alphabet deliberately omits, mapped to their
    // visual twins, so a mistyped O or I still pairs instead of failing opaquely.
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');

  if (!/^[0-9A-HJKMNP-TV-Z]+$/.test(cleaned)) {
    throw new Error('pairing code contains characters that are not part of the alphabet');
  }

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of cleaned) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid character in pairing code');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const secret = Buffer.from(bytes);
  if (secret.length !== SECRET_BYTES) {
    throw new Error(`pairing code must decode to ${SECRET_BYTES} bytes, got ${secret.length}`);
  }
  return secret;
}

/**
 * Separate keys per direction, bound to the device identity, so a device-to-
 * controller frame can never be replayed back as a controller-to-device command.
 */
export function deriveKeys(secret: Buffer, deviceId: string): DirectionalKeys {
  const salt = Buffer.from(deviceId, 'utf8');
  const derive = (info: string): Buffer =>
    Buffer.from(hkdfSync('sha256', secret, salt, Buffer.from(info, 'utf8'), 32));
  return {
    controllerToDevice: derive(`netblock/v${PROTOCOL_VERSION}/c2d`),
    deviceToController: derive(`netblock/v${PROTOCOL_VERSION}/d2c`),
  };
}

/**
 * Six groups of four hex characters, shown on both ends during pairing so the
 * owner can confirm the secret transcribed correctly before trusting the link.
 */
export function fingerprint(secret: Buffer, deviceId: string): string {
  const digest = createHash('sha256')
    .update(Buffer.from(`netblock/v${PROTOCOL_VERSION}/fp`, 'utf8'))
    .update(Buffer.from([0]))
    .update(Buffer.from(deviceId, 'utf8'))
    .update(Buffer.from([0]))
    .update(secret)
    .digest('hex')
    .slice(0, 24)
    .toUpperCase();
  return digest.replace(/(.{4})/g, '$1 ').trim();
}

export function makePairingRecord(deviceId: string, label: string, secret: Buffer, now: number): PairingRecord {
  return {
    version: PROTOCOL_VERSION,
    deviceId,
    label: label.replace(/[\u0000-\u001f]/g, '').slice(0, 64),
    secret: secret.toString('base64'),
    createdAt: now,
    fingerprint: fingerprint(secret, deviceId),
  };
}

export function secretOf(record: PairingRecord): Buffer {
  return Buffer.from(record.secret, 'base64');
}

/** Constant-time comparison, for verifying a fingerprint the owner re-typed. */
export function fingerprintsMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a.replace(/\s/g, '').toUpperCase(), 'utf8');
  const bb = Buffer.from(b.replace(/\s/g, '').toUpperCase(), 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}
