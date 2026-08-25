import { createHash } from 'node:crypto';
import {
  MATERIAL_ADDRESS_FIELDS,
  POLICY,
  type Address,
  type AddressField,
  type Cents,
  type Role,
} from '../domain/types.js';

/**
 * Address change classification (spec §3.4).
 *
 * "Confirm or edit the shipping address" is one line in a workflow and the
 * single largest fraud surface in the system: redirecting a high-value box to
 * an address the insider controls. A freely editable destination removes the
 * property that makes the whole product trustworthy.
 */

const FIELDS: readonly AddressField[] = ['unit', 'line1', 'city', 'postal', 'note'] as const;

export interface AddressDiff {
  changed: boolean;
  fields: AddressField[];
  /** A change of street, city or postal code — a different act from a correction. */
  material: boolean;
}

const norm = (v: string | null | undefined): string => (v ?? '').trim().replace(/\s+/g, ' ');

export function diffAddress(fetched: Address, shipped: Address): AddressDiff {
  const fields = FIELDS.filter(
    (f) => norm(fetched[f as keyof Address] as string) !== norm(shipped[f as keyof Address] as string),
  );
  return {
    changed: fields.length > 0,
    fields,
    material: fields.some((f) => (MATERIAL_ADDRESS_FIELDS as readonly string[]).includes(f)),
  };
}

export type AddressChangeRequirement =
  | { allowed: true; kind: 'CORRECTION'; reason_required: false; approval_required: false }
  | { allowed: true; kind: 'OVERRIDE'; reason_required: true; approval_required: boolean }
  | { allowed: true; kind: 'NO_CHANGE'; reason_required: false; approval_required: false }
  | { allowed: false; code: 'requires_unseal' | 'requires_dispatcher' };

/**
 * What a given address change costs, given where the box is in its lifecycle.
 *
 * The `PICKED_UP` case is a real failure mode: change the address without
 * re-pinning the geofence and the driver arrives at the correct door to a
 * handover the app refuses to unlock.
 */
export function classifyAddressChange(args: {
  fetched: Address;
  shipped: Address;
  declared_cents: Cents;
  box_status: string;
  movement_status?: string | null;
  actor_role: Role;
}): AddressChangeRequirement {
  const d = diffAddress(args.fetched, args.shipped);
  if (!d.changed) {
    return { allowed: true, kind: 'NO_CHANGE', reason_required: false, approval_required: false };
  }

  const dispatcher = args.actor_role === 'DISPATCHER' || args.actor_role === 'SUPER_ADMIN';

  if (args.movement_status === 'PICKED_UP' || args.box_status === 'IN_CUSTODY') {
    if (!dispatcher) return { allowed: false, code: 'requires_dispatcher' };
  } else if (args.box_status === 'SEALED' && !dispatcher) {
    return { allowed: false, code: 'requires_unseal' };
  }

  if (!d.material) {
    return { allowed: true, kind: 'CORRECTION', reason_required: false, approval_required: false };
  }

  return {
    allowed: true,
    kind: 'OVERRIDE',
    reason_required: true,
    approval_required:
      args.declared_cents > POLICY.managerApprovalThresholdCents && args.actor_role === 'STORE_REP',
  };
}

export const OVERRIDE_REASONS = [
  'Customer called to change delivery address',
  'CRM record out of date — confirmed with customer',
  'Ship to workplace at customer request',
  'Correcting an error in the CRM record',
] as const;

// ---------------------------------------------------------------------------
// Hashing for the ledger
// ---------------------------------------------------------------------------

export function canonicalAddress(a: Address): string {
  return [a.unit, a.line1, a.city, a.province, a.postal]
    .map((p) => norm(p as string).toUpperCase())
    .join('|');
}

/**
 * The ledger stores this hash; the plaintext lives in the `pii` schema and is
 * purgeable (spec §2.4).
 *
 * The salt is stored WITH the PII row, so purging the plaintext also destroys
 * the ability to brute-force the address back. A postal-code-sized search space
 * makes an unsalted hash reversible in seconds.
 */
export function addressHash(a: Address, movementSalt: string): string {
  if (!movementSalt) throw new Error('address hash requires a per-movement salt');
  return createHash('sha256').update(canonicalAddress(a) + movementSalt).digest('hex');
}
