import { randomBytes } from 'node:crypto';

/**
 * Prefixed, time-sortable identifiers (spec §0.7): `mov_`, `box_`, `evt_`, …
 * ULID-shaped: 48-bit millisecond timestamp + 80 bits of randomness, Crockford
 * base32, so ids sort by creation time and never collide in practice.
 */

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encode(buf: Uint8Array, bits: number): string {
  let out = '';
  let acc = 0;
  let nbits = 0;
  for (const byte of buf) {
    acc = (acc << 8) | byte;
    nbits += 8;
    while (nbits >= 5 && out.length * 5 < bits) {
      out += B32[(acc >>> (nbits - 5)) & 31];
      nbits -= 5;
    }
  }
  while (out.length * 5 < bits) out += B32[(acc << (5 - nbits)) & 31];
  return out;
}

export function newId(prefix: string): string {
  const t = Date.now();
  const time = new Uint8Array(6);
  for (let i = 5; i >= 0; i--) time[i] = (t / 2 ** (8 * (5 - i))) & 0xff;
  // big-endian 48-bit time
  const tb = new Uint8Array(6);
  let ms = t;
  for (let i = 5; i >= 0; i--) { tb[i] = ms & 0xff; ms = Math.floor(ms / 256); }
  return `${prefix}_${encode(tb, 48)}${encode(randomBytes(10), 80)}`.toLowerCase();
}

/** A 256-bit API key, base64url. Shown once; only its sha256 is stored. */
export function newApiKey(live: boolean): string {
  return `${live ? 'sk_live' : 'sk_test'}_${randomBytes(32).toString('base64url')}`;
}

import { createHash } from 'node:crypto';
/** SHA-256 hex — the lookup hash for high-entropy tokens and OTP codes. */
export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
