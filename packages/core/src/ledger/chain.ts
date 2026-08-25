import { createHash } from 'node:crypto';

/**
 * The custody chain (spec §2.2).
 *
 * This is the single implementation of canonicalisation and hashing. It is
 * imported by the API to append and by the admin console to verify. A second
 * implementation anywhere means the two can disagree, and a chain that cannot
 * be independently recomputed is not evidence.
 */

export const GENESIS = '0'.repeat(64);

/**
 * Deterministic JSON: keys sorted at every level, `undefined` dropped, dates as
 * ISO-8601 Z. Two structurally equal objects must always produce the same string.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(prepare(value));
}

function prepare(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(prepare);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = prepare(x);
    }
    return out;
  }
  return v;
}

export interface LedgerEventInput {
  id: string;
  type: string;
  detail: Record<string, unknown>;
  actor_role: string;
  actor_user_id: string | null;
  movement_id: string | null;
  box_id?: string | null;
  at: Date;
  prev_hash: string;
}

export interface LedgerEvent extends LedgerEventInput {
  hash: string;
  seq?: number;
}

export function eventHash(e: LedgerEventInput): string {
  return createHash('sha256')
    .update(
      canonical({
        prev_hash: e.prev_hash,
        id: e.id,
        movement_id: e.movement_id,
        box_id: e.box_id ?? null,
        type: e.type,
        detail: e.detail,
        actor_role: e.actor_role,
        actor_user_id: e.actor_user_id,
        at: e.at,
      }),
    )
    .digest('hex');
}

export function seal(input: LedgerEventInput): LedgerEvent {
  return { ...input, hash: eventHash(input) };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type VerifyResult =
  | { ok: true; verified_to: string; count: number }
  | { ok: false; break_at: number; reason: 'prev_mismatch' | 'hash_mismatch' | 'seq_gap' };

/**
 * Recompute the chain. Raw JSON is not evidence; a recomputation that names the
 * first broken link is (§2.6).
 */
export function verifyChain(events: readonly LedgerEvent[], from = GENESIS): VerifyResult {
  let prev = from;
  let expectedSeq: number | null = null;

  for (const e of events) {
    if (e.seq !== undefined) {
      if (expectedSeq !== null && e.seq !== expectedSeq) {
        return { ok: false, break_at: e.seq, reason: 'seq_gap' };
      }
      expectedSeq = e.seq + 1;
    }
    if (e.prev_hash !== prev) {
      return { ok: false, break_at: e.seq ?? -1, reason: 'prev_mismatch' };
    }
    if (eventHash(e) !== e.hash) {
      return { ok: false, break_at: e.seq ?? -1, reason: 'hash_mismatch' };
    }
    prev = e.hash;
  }
  return { ok: true, verified_to: prev, count: events.length };
}

// ---------------------------------------------------------------------------
// Daily Merkle root (§2.5)
// ---------------------------------------------------------------------------

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Duplicates the last leaf on odd counts. Empty input yields the genesis value. */
export function merkleRoot(leafHashes: readonly string[]): string {
  if (leafHashes.length === 0) return GENESIS;
  let level = [...leafHashes];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] ?? a;
      next.push(sha(a + b));
    }
    level = next;
  }
  return level[0];
}
