import { LEDGER_READ_ROLES, UNSEAL_APPROVER_ROLES, type Principal, type Role } from '../domain/types.js';

/**
 * Authorisation (spec §0.5, §6.4).
 *
 * Hiding a panel in the UI is not a permission. Every route consults this.
 */

export type Action =
  | 'ledger.read'
  | 'ledger.verify'
  | 'box.pack'
  | 'box.seal'
  | 'box.unseal.request'
  | 'box.unseal.approve'
  | 'movement.book'
  | 'movement.cancel'
  | 'movement.reassign'
  | 'address.override'
  | 'address.override.review'
  | 'driver.act'
  | 'admin.config'
  | 'pii.purge';

export interface Resource {
  provider_id?: string | null;
  store_id?: string | null;
  driver_user_id?: string | null;
  movement_id?: string | null;
}

const ROLE_ACTIONS: Record<Role, readonly Action[]> = {
  SUPER_ADMIN: [
    'ledger.read', 'ledger.verify', 'box.pack', 'box.seal', 'box.unseal.request',
    'box.unseal.approve', 'movement.book', 'movement.cancel', 'movement.reassign',
    'address.override', 'address.override.review', 'admin.config', 'pii.purge',
  ],
  DISPATCHER: [
    'ledger.read', 'movement.book', 'movement.cancel', 'movement.reassign',
    'address.override', 'address.override.review',
  ],
  DRIVER: ['driver.act'],
  PROVIDER_ADMIN: [
    'ledger.read', 'ledger.verify', 'movement.book', 'movement.cancel',
    'address.override', 'address.override.review',
  ],
  STORE_MANAGER: [
    'ledger.read', 'box.pack', 'box.seal', 'box.unseal.request', 'box.unseal.approve',
    'movement.book', 'movement.cancel', 'address.override', 'address.override.review',
  ],
  // STORE_REP: packing only. No ledger, ever. No unseal approval.
  STORE_REP: [
    'box.pack', 'box.seal', 'box.unseal.request', 'movement.book',
    'movement.cancel', 'address.override',
  ],
};

function inScope(p: Principal, res?: Resource): boolean {
  if (!res) return true;
  if (p.kind === 'recipient') return !res.movement_id || res.movement_id === p.movement_id;
  if (p.kind === 'api_key') return !res.provider_id || res.provider_id === p.provider_id;

  switch (p.role) {
    case 'SUPER_ADMIN':
    case 'DISPATCHER':
      return true;
    case 'PROVIDER_ADMIN':
      return !res.provider_id || res.provider_id === p.provider_id;
    case 'STORE_MANAGER':
    case 'STORE_REP':
      return (
        (!res.store_id || res.store_id === p.store_id) &&
        (!res.provider_id || res.provider_id === p.provider_id)
      );
    case 'DRIVER':
      return !res.driver_user_id || res.driver_user_id === p.user_id;
  }
}

export function can(p: Principal, action: Action, res?: Resource): boolean {
  if (p.kind === 'recipient') return false;
  if (p.kind === 'api_key') {
    const allowed: Action[] = ['movement.book', 'movement.cancel', 'ledger.read'];
    return allowed.includes(action) && inScope(p, res);
  }
  return ROLE_ACTIONS[p.role].includes(action) && inScope(p, res);
}

/** Convenience, and a place to assert the decision that will be re-litigated. */
export const canReadLedger = (role: Role): boolean => LEDGER_READ_ROLES.includes(role);

/**
 * Who may approve breaking a seal. The requester is always excluded — a code
 * sent to the person opening the box proves only that they still hold their own
 * phone (§3.1).
 */
export function resolveUnsealApprover<T extends { user_id: string; role: Role; store_id?: string | null }>(
  requester: { user_id: string; store_id?: string | null },
  candidates: readonly T[],
): T | null {
  const eligible = candidates.filter(
    (c) =>
      c.user_id !== requester.user_id &&
      UNSEAL_APPROVER_ROLES.includes(c.role) &&
      (c.role === 'SUPER_ADMIN' || c.store_id === requester.store_id),
  );
  return eligible.find((c) => c.role === 'STORE_MANAGER') ?? eligible[0] ?? null;
}
