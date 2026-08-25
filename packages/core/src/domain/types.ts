/**
 * CUSTODE — shared domain contract.
 *
 * This file and its siblings are imported by the API, the web apps and the mobile
 * app. Duplicating any validator, price or enum defined here is a review-blocking
 * defect (spec §0.6).
 */

// ---------------------------------------------------------------------------
// Roles and principals
// ---------------------------------------------------------------------------

export const ROLES = [
  'SUPER_ADMIN',
  'DISPATCHER',
  'DRIVER',
  'PROVIDER_ADMIN',
  'STORE_MANAGER',
  'STORE_REP',
] as const;
export type Role = (typeof ROLES)[number];

/** Roles that may read the custody chain. STORE_REP is deliberately absent (§6.5). */
export const LEDGER_READ_ROLES: readonly Role[] = [
  'SUPER_ADMIN',
  'DISPATCHER',
  'PROVIDER_ADMIN',
  'STORE_MANAGER',
] as const;

/** Roles that may approve breaking a seal. The requester is excluded at runtime (§3.1). */
export const UNSEAL_APPROVER_ROLES: readonly Role[] = ['STORE_MANAGER', 'SUPER_ADMIN'] as const;

export type Principal =
  | { kind: 'user'; user_id: string; role: Role; provider_id?: string; store_id?: string }
  | { kind: 'api_key'; key_id: string; provider_id: string }
  | { kind: 'recipient'; movement_id: string };

export type Locale = 'fr-CA' | 'en-CA';
export const DEFAULT_LOCALE: Locale = 'fr-CA';

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export const ITEM_TYPES = ['IMEI', 'SERIAL', 'ICCID', 'SKU', 'UNKNOWN'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export interface ItemTypeSpec {
  /** Unique identity: quantity is always 1, and it may live on only one open box. */
  serialized: boolean;
  validator: 'luhn15' | 'iccid' | null;
}

/**
 * Luhn is selected *by item type*, never applied universally — a charger's UPC
 * will fail Luhn and must not be refused (§1.2).
 */
export const ITEM_TYPE_SPEC: Record<ItemType, ItemTypeSpec> = {
  IMEI: { serialized: true, validator: 'luhn15' },
  SERIAL: { serialized: true, validator: null },
  ICCID: { serialized: true, validator: 'iccid' },
  SKU: { serialized: false, validator: null },
  UNKNOWN: { serialized: false, validator: null },
};

export const isSerialized = (t: ItemType): boolean => ITEM_TYPE_SPEC[t].serialized;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const BOX_STATUSES = ['OPEN', 'SEALED', 'IN_CUSTODY', 'RELEASED', 'ABANDONED'] as const;
export type BoxStatus = (typeof BOX_STATUSES)[number];

export const SEAL_STATUSES = ['ISSUED', 'APPLIED', 'VOIDED', 'CLOSED'] as const;
export type SealStatus = (typeof SEAL_STATUSES)[number];

export const MOVEMENT_STATUSES = [
  'BOOKED',
  'OFFERED',
  'ASSIGNED',
  'PICKED_UP',
  'DELIVERED',
  'EXCEPTION',
  'CANCELLED',
  'RECALLED',
] as const;
export type MovementStatus = (typeof MOVEMENT_STATUSES)[number];

/** A movement in one of these is live: it has been sold and not yet closed. */
export const OPEN_MOVEMENT_STATUSES: readonly MovementStatus[] = [
  'BOOKED',
  'OFFERED',
  'ASSIGNED',
  'PICKED_UP',
  'EXCEPTION',
] as const;

export const EXCEPTION_CODES = [
  'RECIPIENT_ABSENT',
  'RECIPIENT_REFUSED',
  'ADDRESS_INVALID',
  'ACCESS_BLOCKED',
  'SEAL_COMPROMISED',
  'ID_MISMATCH',
  'UNSAFE',
  'VEHICLE',
  'WEATHER',
] as const;
export type ExceptionCode = (typeof EXCEPTION_CODES)[number];

// ---------------------------------------------------------------------------
// Policy constants (§3)
// ---------------------------------------------------------------------------

export const POLICY = {
  /** Free cancellation window, from booking. */
  freeCancelMinutes: 60,
  cancelFeeCents: 500,

  otpLength: 6,
  otpTtlMinutes: 10,
  otpMaxAttempts: 5,

  /** Handover is refused beyond this distance. Not disableable in any UI. */
  geofenceMetres: 100,
  gpsAccuracyFloorMetres: 100,
  offRouteKmDefault: 2,

  /** A material address change above this declared value needs manager approval. */
  managerApprovalThresholdCents: 200_000,

  /** Suggest a re-route only when it beats this, or drivers tune it out. */
  resequenceMinSavingSeconds: 480,

  offerTimeoutMinutes: 15,
} as const;

/** Address fields whose change is a *material* override, not a correction (§3.4). */
export const MATERIAL_ADDRESS_FIELDS = ['line1', 'city', 'postal'] as const;
export type AddressField = 'unit' | 'line1' | 'city' | 'postal' | 'note';

export interface Address {
  unit?: string | null;
  line1: string;
  city: string;
  province: string;
  postal: string;
  note?: string | null;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** Always integer cents, CAD. A float anywhere in the money path is a bug (§0.7). */
export type Cents = number;

export const formatCents = (c: Cents, locale: Locale = DEFAULT_LOCALE): string =>
  new Intl.NumberFormat(locale, { style: 'currency', currency: 'CAD' }).format(c / 100);
