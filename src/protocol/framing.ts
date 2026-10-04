/**
 * Length-prefixed JSON framing over a byte stream.
 *
 * 4-byte big-endian length, then that many bytes of UTF-8 JSON. The decoder
 * tolerates arbitrary chunk boundaries (TCP gives no message boundaries) and
 * refuses oversized frames before allocating for them.
 */

import { MAX_FRAME_BYTES } from './envelope.ts';

export const HEADER_BYTES = 4;

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > MAX_FRAME_BYTES) throw new Error('frame too large to send');
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);
  #failed = false;

  /**
   * Feed bytes, get back whole frames. Returns `null` for the frame list once
   * the stream has been poisoned by a protocol violation; the caller must then
   * close the connection rather than try to resynchronise.
   */
  push(chunk: Buffer): { frames: unknown[]; error?: string } {
    if (this.#failed) return { frames: [], error: 'decoder already failed' };
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);

    const frames: unknown[] = [];
    for (;;) {
      if (this.#buffer.length < HEADER_BYTES) break;
      const length = this.#buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        this.#failed = true;
        return { frames, error: `frame length ${length} exceeds limit` };
      }
      if (this.#buffer.length < HEADER_BYTES + length) break;
      const body = this.#buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
      this.#buffer = this.#buffer.subarray(HEADER_BYTES + length);
      try {
        frames.push(JSON.parse(body.toString('utf8')));
      } catch {
        this.#failed = true;
        return { frames, error: 'frame body is not valid JSON' };
      }
    }
    return { frames };
  }

  get buffered(): number {
    return this.#buffer.length;
  }

  get failed(): boolean {
    return this.#failed;
  }
}
