import { isSerialized, type Cents, type ItemType } from '../domain/types.js';

/**
 * Reconciliation — comparing what was scanned into a box against what the
 * provider's work order says should be in it (spec §3.3).
 *
 * This is the two-source match: a manifest that agrees with an independently
 * generated pick list is the strongest evidence in the product.
 */

export interface ScannedLine {
  code: string;
  item_type: ItemType;
  label: string;
  qty: number;
  value_cents: Cents;
}

export interface ExpectedLine {
  code: string;
  qty: number;
  label?: string;
  item_type?: ItemType;
  value_cents?: Cents;
}

export type LineStatus =
  | 'HIT'      // scanned qty === expected qty
  | 'MISSING'  // expected, nothing scanned
  | 'SHORT'    // scanned fewer than expected
  | 'OVER'     // scanned more than expected
  | 'EXTRA'    // scanned, not on the ticket
  | 'PENDING'; // scanned before a ticket was attached

export interface ReconciledLine {
  code: string;
  label: string;
  item_type: ItemType;
  value_cents: Cents;
  got: number;
  want: number;
  status: LineStatus;
}

export interface Reconciliation {
  lines: ReconciledLine[];
  missing: number;
  short: number;
  over: number;
  extra: number;
  /** Every expected line matched exactly and nothing unexpected was scanned. */
  clean: boolean;
  units: number;
  declared_cents: Cents;
  /** True when sealing requires a discrepancy reason. */
  needs_reason: boolean;
}

export function reconcile(
  scanned: readonly ScannedLine[],
  expected: readonly ExpectedLine[] | null,
): Reconciliation {
  const lines: ReconciledLine[] = [];
  const byCode = new Map<string, ScannedLine[]>();
  for (const s of scanned) {
    const arr = byCode.get(s.code);
    if (arr) arr.push(s);
    else byCode.set(s.code, [s]);
  }

  const expectedCodes = new Set<string>();

  for (const e of expected ?? []) {
    expectedCodes.add(e.code);
    const hits = byCode.get(e.code) ?? [];
    const got = hits.reduce((n, h) => n + h.qty, 0);
    const first = hits[0];
    lines.push({
      code: e.code,
      label: first?.label ?? e.label ?? e.code,
      item_type: first?.item_type ?? e.item_type ?? 'UNKNOWN',
      value_cents: first?.value_cents ?? e.value_cents ?? 0,
      got,
      want: e.qty,
      status: got === e.qty ? 'HIT' : got === 0 ? 'MISSING' : got < e.qty ? 'SHORT' : 'OVER',
    });
  }

  for (const s of scanned) {
    if (expectedCodes.has(s.code)) continue;
    // collapse repeats of the same code into one line
    if (lines.some((l) => l.code === s.code && l.want === 0)) continue;
    const got = (byCode.get(s.code) ?? []).reduce((n, h) => n + h.qty, 0);
    lines.push({
      code: s.code,
      label: s.label,
      item_type: s.item_type,
      value_cents: s.value_cents,
      got,
      want: 0,
      status: expected === null ? 'PENDING' : 'EXTRA',
    });
  }

  const count = (st: LineStatus) => lines.filter((l) => l.status === st).length;
  const missing = count('MISSING');
  const short = count('SHORT');
  const over = count('OVER');
  const extra = count('EXTRA');

  return {
    lines,
    missing,
    short,
    over,
    extra,
    clean: expected !== null && lines.length > 0 && lines.every((l) => l.status === 'HIT'),
    units: scanned.reduce((n, s) => n + s.qty, 0),
    declared_cents: scanned.reduce((n, s) => n + s.value_cents * s.qty, 0),
    needs_reason: missing + short + over + extra > 0,
  };
}

// ---------------------------------------------------------------------------
// Scan admission
// ---------------------------------------------------------------------------

export type ScanRejection =
  | 'manifest_locked'
  | 'duplicate_serialized_item'
  | 'serialized_item_in_transit';

export type ScanOutcome =
  | { action: 'ADD'; qty: 1 }
  | { action: 'INCREMENT'; qty: number }
  | { action: 'CAPTURE_UNKNOWN' }
  | { action: 'REJECT'; reason: ScanRejection };

export interface ScanContext {
  box_status: string;
  /** Lines already on this box. */
  existing: readonly ScannedLine[];
  /** True when this serialized code is on another box with an open movement. */
  serialized_elsewhere: boolean;
  /** Null when the barcode is not in the provider catalogue. */
  catalogue: { item_type: ItemType } | null;
}

/**
 * The decision a scan makes. Never blocks the session for an unrecognised
 * barcode — that routes to capture-with-photo (§3.3).
 */
export function admitScan(code: string, ctx: ScanContext): ScanOutcome {
  if (ctx.box_status !== 'OPEN') return { action: 'REJECT', reason: 'manifest_locked' };
  if (!ctx.catalogue) return { action: 'CAPTURE_UNKNOWN' };

  const serialized = isSerialized(ctx.catalogue.item_type);
  const existing = ctx.existing.find((l) => l.code === code);

  if (serialized) {
    if (existing) return { action: 'REJECT', reason: 'duplicate_serialized_item' };
    if (ctx.serialized_elsewhere) return { action: 'REJECT', reason: 'serialized_item_in_transit' };
    return { action: 'ADD', qty: 1 };
  }

  // A repeated SKU is six cases, not a duplicate. This must never warn.
  return existing ? { action: 'INCREMENT', qty: existing.qty + 1 } : { action: 'ADD', qty: 1 };
}
