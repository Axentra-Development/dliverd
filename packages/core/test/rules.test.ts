import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  validateItem, luhn, inferItemType,
  reconcile, admitScan,
  diffAddress, classifyAddressChange, canonicalAddress, addressHash,
  availableServices, cancelQuote, freeCancelUntil, SERVICES, DEFAULT_SERVICE_CODE,
  can, canReadLedger, resolveUnsealApprover,
  seal, verifyChain, merkleRoot, canonical, GENESIS,
  POLICY, ROLES,
  type Address, type Role, type ScannedLine, type LedgerEventInput,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Item validation — the Luhn-by-type defect
// ---------------------------------------------------------------------------

describe('item validation', () => {
  it('accepts a valid IMEI', () => {
    expect(validateItem('356938035643809', 'IMEI')).toEqual({ ok: true });
  });

  it('rejects an IMEI that fails Luhn', () => {
    expect(validateItem('356938035643801', 'IMEI')).toEqual({ ok: false, reason: 'luhn_failed' });
  });

  it("does NOT Luhn-check a charger's UPC — the original defect", () => {
    // 194253407409 is a real-shaped UPC and fails Luhn. It must still be accepted.
    expect(luhn('194253407409')).toBe(false);
    expect(validateItem('194253407409', 'SKU')).toEqual({ ok: true });
  });

  it('accepts an arbitrary vendor serial', () => {
    expect(validateItem('SR-IPADAIR-7742', 'SERIAL')).toEqual({ ok: true });
  });

  it('rejects an IMEI of the wrong length before checksumming', () => {
    expect(validateItem('35693803564380', 'IMEI')).toEqual({ ok: false, reason: 'wrong_length' });
  });

  it('infers type from barcode shape only', () => {
    expect(inferItemType('356938035643809')).toBe('IMEI');
    expect(inferItemType('194253407409')).toBe('SKU');   // UPC-A
    expect(inferItemType('0009988776655')).toBe('SKU');  // EAN-13 shape — shape alone says SKU
    expect(inferItemType('SR-IPADAIR-7742')).toBe('UNKNOWN');
    expect(inferItemType('')).toBe('UNKNOWN');
  });

  it('shape is not recognition — catalogue absence is what triggers unknown capture', () => {
    // A well-formed EAN-13 that is not in the provider's catalogue must still go
    // to capture-with-photo, never be silently accepted as a known SKU (§3.3).
    expect(inferItemType('0009988776655')).toBe('SKU');
    expect(admitScan('0009988776655', {
      box_status: 'OPEN', existing: [], serialized_elsewhere: false, catalogue: null,
    })).toEqual({ action: 'CAPTURE_UNKNOWN' });
  });
});

// ---------------------------------------------------------------------------
// Scan admission — serialized vs non-serialized
// ---------------------------------------------------------------------------

describe('scan admission', () => {
  const line = (code: string, qty = 1): ScannedLine =>
    ({ code, item_type: 'SKU', label: 'x', qty, value_cents: 100 });

  it('refuses the same IMEI twice on one box', () => {
    const existing: ScannedLine[] = [{ ...line('356938035643809'), item_type: 'IMEI' }];
    expect(admitScan('356938035643809', {
      box_status: 'OPEN', existing, serialized_elsewhere: false,
      catalogue: { item_type: 'IMEI' },
    })).toEqual({ action: 'REJECT', reason: 'duplicate_serialized_item' });
  });

  it('refuses a serialized item already in transit elsewhere', () => {
    expect(admitScan('356938035643809', {
      box_status: 'OPEN', existing: [], serialized_elsewhere: true,
      catalogue: { item_type: 'IMEI' },
    })).toEqual({ action: 'REJECT', reason: 'serialized_item_in_transit' });
  });

  it('increments a repeated SKU — six cases is not a duplicate', () => {
    expect(admitScan('194253991755', {
      box_status: 'OPEN', existing: [line('194253991755', 1)], serialized_elsewhere: false,
      catalogue: { item_type: 'SKU' },
    })).toEqual({ action: 'INCREMENT', qty: 2 });
  });

  it('captures an unknown barcode instead of blocking the session', () => {
    expect(admitScan('0009988776655', {
      box_status: 'OPEN', existing: [], serialized_elsewhere: false, catalogue: null,
    })).toEqual({ action: 'CAPTURE_UNKNOWN' });
  });

  it('refuses any scan once the manifest is locked', () => {
    expect(admitScan('194253991755', {
      box_status: 'SEALED', existing: [], serialized_elsewhere: false,
      catalogue: { item_type: 'SKU' },
    })).toEqual({ action: 'REJECT', reason: 'manifest_locked' });
  });
});

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

describe('reconciliation', () => {
  const scanned: ScannedLine[] = [
    { code: 'A', item_type: 'IMEI', label: 'phone', qty: 1, value_cents: 144900 },
    { code: 'B', item_type: 'SKU', label: 'case', qty: 2, value_cents: 6500 },
  ];

  it('is clean when scans match the ticket exactly', () => {
    const r = reconcile(scanned, [{ code: 'A', qty: 1 }, { code: 'B', qty: 2 }]);
    expect(r.clean).toBe(true);
    expect(r.needs_reason).toBe(false);
    expect(r.units).toBe(3);
    expect(r.declared_cents).toBe(144900 + 6500 * 2);
  });

  it('flags a missing line and blocks a clean seal', () => {
    const r = reconcile(scanned, [{ code: 'A', qty: 1 }, { code: 'B', qty: 2 }, { code: 'C', qty: 1 }]);
    expect(r.missing).toBe(1);
    expect(r.clean).toBe(false);
    expect(r.needs_reason).toBe(true);
  });

  it('flags an item not on the ticket without refusing the scan', () => {
    const r = reconcile(scanned, [{ code: 'A', qty: 1 }]);
    expect(r.extra).toBe(1);
    expect(r.lines.find((l) => l.code === 'B')?.status).toBe('EXTRA');
  });

  it('marks lines PENDING when packed before a ticket was attached', () => {
    const r = reconcile(scanned, null);
    expect(r.lines.every((l) => l.status === 'PENDING')).toBe(true);
    expect(r.clean).toBe(false);
  });

  it('distinguishes SHORT from OVER', () => {
    const r = reconcile(scanned, [{ code: 'A', qty: 2 }, { code: 'B', qty: 1 }]);
    expect(r.lines.find((l) => l.code === 'A')?.status).toBe('SHORT');
    expect(r.lines.find((l) => l.code === 'B')?.status).toBe('OVER');
  });
});

// ---------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------

const ADDR: Address = {
  unit: '', line1: '6321 rue Beaubien E', city: 'Montréal',
  province: 'QC', postal: 'H1M 2Y8', note: '',
};

describe('address change classification', () => {
  it('treats a buzzer note as a free correction', () => {
    const c = classifyAddressChange({
      fetched: ADDR, shipped: { ...ADDR, note: 'Sonner deux fois' },
      declared_cents: 144900, box_status: 'OPEN', actor_role: 'STORE_REP',
    });
    expect(c).toMatchObject({ allowed: true, kind: 'CORRECTION', reason_required: false });
  });

  it('treats a street change as a material override needing a reason', () => {
    const c = classifyAddressChange({
      fetched: ADDR, shipped: { ...ADDR, line1: '980 rue Fleury E' },
      declared_cents: 100_00, box_status: 'OPEN', actor_role: 'STORE_REP',
    });
    expect(c).toMatchObject({ allowed: true, kind: 'OVERRIDE', reason_required: true });
  });

  it('escalates a high-value material override to manager approval', () => {
    const c = classifyAddressChange({
      fetched: ADDR, shipped: { ...ADDR, city: 'Laval' },
      declared_cents: POLICY.managerApprovalThresholdCents + 1,
      box_status: 'OPEN', actor_role: 'STORE_REP',
    });
    expect(c).toMatchObject({ kind: 'OVERRIDE', approval_required: true });
  });

  it('requires an unseal once the box is sealed', () => {
    const c = classifyAddressChange({
      fetched: ADDR, shipped: { ...ADDR, line1: 'X' },
      declared_cents: 100, box_status: 'SEALED', actor_role: 'STORE_REP',
    });
    expect(c).toEqual({ allowed: false, code: 'requires_unseal' });
  });

  it('requires a dispatcher once the box is in custody', () => {
    const c = classifyAddressChange({
      fetched: ADDR, shipped: { ...ADDR, line1: 'X' }, declared_cents: 100,
      box_status: 'IN_CUSTODY', movement_status: 'PICKED_UP', actor_role: 'STORE_MANAGER',
    });
    expect(c).toEqual({ allowed: false, code: 'requires_dispatcher' });
  });

  it('ignores whitespace and case when diffing', () => {
    expect(diffAddress(ADDR, { ...ADDR, line1: '  6321   rue Beaubien E ' }).changed).toBe(false);
  });
});

describe('address hashing', () => {
  it('refuses to hash without a per-movement salt', () => {
    expect(() => addressHash(ADDR, '')).toThrow(/salt/);
  });

  it('is stable for equal addresses and differs across salts', () => {
    expect(addressHash(ADDR, 's1')).toBe(addressHash({ ...ADDR }, 's1'));
    expect(addressHash(ADDR, 's1')).not.toBe(addressHash(ADDR, 's2'));
  });

  it('canonicalises case and spacing', () => {
    expect(canonicalAddress(ADDR)).toBe(canonicalAddress({ ...ADDR, city: '  montréal ' }));
  });
});

// ---------------------------------------------------------------------------
// Pricing, cutoffs, cancellation
// ---------------------------------------------------------------------------

describe('services and cutoffs', () => {
  it('defaults to CUSTODE 24 at $10.75, first in the list', () => {
    const first = [...SERVICES].sort((a, b) => a.sort_order - b.sort_order)[0];
    expect(first.code).toBe(DEFAULT_SERVICE_CODE);
    expect(first.price_cents).toBe(1075);
  });

  it('shows morning services as unavailable with a reason after cutoff', () => {
    // 20:10 UTC = 16:10 in Toronto (EDT), past a 16:00 cutoff
    const at = new Date('2026-08-25T20:10:00Z');
    const list = availableServices({ at, timeZone: 'America/Toronto', cutoffLocal: '16:00' });
    const am = list.find((s) => s.code === 'CUSTODE_24_AM')!;
    expect(am.available).toBe(false);
    expect(am.unavailable_reason).toBe('cutoff_passed');
    // never omitted
    expect(list).toHaveLength(SERVICES.length);
    expect(list.find((s) => s.code === 'CUSTODE_24')!.available).toBe(true);
  });

  it('keeps morning services available before cutoff', () => {
    const at = new Date('2026-08-25T13:00:00Z'); // 09:00 Toronto
    const list = availableServices({ at, timeZone: 'America/Toronto', cutoffLocal: '16:00' });
    expect(list.every((s) => s.available)).toBe(true);
  });
});

describe('cancellation', () => {
  const booked_at = new Date('2026-08-25T12:00:00Z');

  it('is free inside the hour', () => {
    const q = cancelQuote({ status: 'OFFERED', booked_at }, new Date('2026-08-25T12:59:00Z'));
    expect(q).toMatchObject({ allowed: true, fee_cents: 0 });
  });

  it('charges $5.00 after the hour', () => {
    const q = cancelQuote({ status: 'OFFERED', booked_at }, new Date('2026-08-25T13:01:00Z'));
    expect(q).toMatchObject({ allowed: true, fee_cents: 500 });
  });

  it('refuses once in custody', () => {
    const q = cancelQuote({ status: 'PICKED_UP', booked_at }, new Date('2026-08-25T12:10:00Z'));
    expect(q).toMatchObject({ allowed: false, reason: 'in_custody' });
  });

  it('freezes the free window at booking', () => {
    expect(freeCancelUntil(booked_at).toISOString()).toBe('2026-08-25T13:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Authorisation — the STORE_REP ledger gate
// ---------------------------------------------------------------------------

describe('authorisation', () => {
  const rep = { kind: 'user', user_id: 'u1', role: 'STORE_REP', provider_id: 'p', store_id: 's' } as const;
  const mgr = { kind: 'user', user_id: 'u2', role: 'STORE_MANAGER', provider_id: 'p', store_id: 's' } as const;

  it('STORE_REP can never read the ledger', () => {
    expect(can(rep, 'ledger.read')).toBe(false);
    expect(can(rep, 'ledger.read', { store_id: 's' })).toBe(false);
    expect(canReadLedger('STORE_REP')).toBe(false);
  });

  it('STORE_REP can pack and seal', () => {
    expect(can(rep, 'box.pack', { store_id: 's' })).toBe(true);
    expect(can(rep, 'box.seal', { store_id: 's' })).toBe(true);
  });

  it('STORE_REP cannot approve an unseal', () => {
    expect(can(rep, 'box.unseal.approve', { store_id: 's' })).toBe(false);
    expect(can(mgr, 'box.unseal.approve', { store_id: 's' })).toBe(true);
  });

  it('scopes a store role to its own store', () => {
    expect(can(mgr, 'box.seal', { store_id: 'other' })).toBe(false);
  });

  it('a recipient token can do nothing but be scoped', () => {
    const r = { kind: 'recipient', movement_id: 'm1' } as const;
    for (const a of ['ledger.read', 'box.seal', 'movement.book'] as const) expect(can(r, a)).toBe(false);
  });

  it('every role is covered by the action table', () => {
    for (const role of ROLES) {
      const p = { kind: 'user', user_id: 'u', role } as const;
      expect(() => can(p, 'box.pack')).not.toThrow();
    }
  });
});

describe('unseal approver resolution', () => {
  const staff = [
    { user_id: 'rep', role: 'STORE_REP' as Role, store_id: 's' },
    { user_id: 'mgr', role: 'STORE_MANAGER' as Role, store_id: 's' },
    { user_id: 'other', role: 'STORE_MANAGER' as Role, store_id: 'elsewhere' },
  ];

  it('sends the code to a manager who is not the requester', () => {
    expect(resolveUnsealApprover({ user_id: 'rep', store_id: 's' }, staff)?.user_id).toBe('mgr');
  });

  it('never resolves to the requester themselves', () => {
    expect(resolveUnsealApprover({ user_id: 'mgr', store_id: 's' }, staff)?.user_id).not.toBe('mgr');
  });

  it('does not borrow a manager from another store', () => {
    expect(resolveUnsealApprover({ user_id: 'mgr', store_id: 's' }, staff)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

const ev = (i: number, prev: string): LedgerEventInput => ({
  id: `evt_${i}`, type: 'item.scanned', detail: { code: `c${i}`, qty: 1 },
  actor_role: 'STORE_REP', actor_user_id: 'u1', movement_id: 'mov_1',
  at: new Date(Date.UTC(2026, 7, 25, 9, i)), prev_hash: prev,
});

function build(n: number) {
  const out = [];
  let prev = GENESIS;
  for (let i = 0; i < n; i++) {
    const e = { ...seal(ev(i, prev)), seq: i };
    out.push(e); prev = e.hash;
  }
  return out;
}

describe('custody chain', () => {
  it('canonicalises independently of key order', () => {
    expect(canonical({ b: 1, a: { d: 2, c: 3 } })).toBe(canonical({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('drops undefined but keeps null', () => {
    expect(canonical({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('verifies a well-formed chain', () => {
    const r = verifyChain(build(50));
    expect(r).toMatchObject({ ok: true, count: 50 });
  });

  it('detects a tampered detail', () => {
    const c = build(20);
    (c[7].detail as Record<string, unknown>).qty = 99;
    expect(verifyChain(c)).toEqual({ ok: false, break_at: 7, reason: 'hash_mismatch' });
  });

  it('detects a removed event', () => {
    const c = build(20);
    c.splice(9, 1);
    const r = verifyChain(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(['seq_gap', 'prev_mismatch']).toContain(r.reason);
  });

  it('detects a reordered pair', () => {
    const c = build(20);
    [c[4], c[5]] = [c[5], c[4]];
    expect(verifyChain(c).ok).toBe(false);
  });

  it('property: any valid sequence verifies', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 120 }), (n) => {
      expect(verifyChain(build(n)).ok).toBe(true);
    }), { numRuns: 60 });
  });

  it('property: mutating any single event breaks verification', () => {
    fc.assert(fc.property(
      fc.integer({ min: 2, max: 40 }),
      fc.integer({ min: 0, max: 39 }),
      (n, raw) => {
        const c = build(n);
        const i = raw % n;
        (c[i].detail as Record<string, unknown>).tampered = true;
        expect(verifyChain(c).ok).toBe(false);
      },
    ), { numRuns: 60 });
  });
});

describe('merkle root', () => {
  it('is stable and order-sensitive', () => {
    const a = ['aa', 'bb', 'cc'];
    expect(merkleRoot(a)).toBe(merkleRoot(['aa', 'bb', 'cc']));
    expect(merkleRoot(a)).not.toBe(merkleRoot(['bb', 'aa', 'cc']));
  });

  it('handles odd counts by duplicating the last leaf', () => {
    expect(merkleRoot(['aa'])).toBe('aa');
    expect(merkleRoot(['aa', 'bb', 'cc'])).toHaveLength(64);
  });

  it('returns genesis for an empty day', () => {
    expect(merkleRoot([])).toBe(GENESIS);
  });
});
