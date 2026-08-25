import { ITEM_TYPE_SPEC, isSerialized, type ItemType } from '../domain/types.js';

/**
 * Item identifier validation.
 *
 * The rule that matters: validation is selected by item type. The previous
 * implementation ran a Luhn check over every entry and rejected the booking on
 * failure, which refuses a charger's UPC (spec §1.2).
 */

export type ItemValidationError =
  | 'luhn_failed'
  | 'wrong_length'
  | 'not_numeric'
  | 'iccid_invalid'
  | 'empty';

export type ItemValidation = { ok: true } | { ok: false; reason: ItemValidationError };

const ok: ItemValidation = { ok: true };
const fail = (reason: ItemValidationError): ItemValidation => ({ ok: false, reason });

/** Luhn checksum over a digit string. */
export function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const c = digits.charCodeAt(i) - 48;
    if (c < 0 || c > 9) return false;
    let d = c;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function validateItem(code: string, type: ItemType): ItemValidation {
  const raw = code.trim();
  if (!raw) return fail('empty');

  const spec = ITEM_TYPE_SPEC[type];
  switch (spec.validator) {
    case 'luhn15': {
      if (!/^\d+$/.test(raw)) return fail('not_numeric');
      if (raw.length !== 15) return fail('wrong_length');
      return luhn(raw) ? ok : fail('luhn_failed');
    }
    case 'iccid': {
      // 19 or 20 digits, Luhn-checked, ITU-T E.118 major industry identifier 89.
      if (!/^\d+$/.test(raw)) return fail('not_numeric');
      if (raw.length < 19 || raw.length > 20) return fail('wrong_length');
      if (!raw.startsWith('89')) return fail('iccid_invalid');
      return luhn(raw) ? ok : fail('luhn_failed');
    }
    case null:
      // SKU, SERIAL, UNKNOWN — no checksum exists. Accept whatever the scanner read.
      return ok;
  }
}

/**
 * Guess the item type from the shape of a barcode, for the case where the
 * catalogue has no entry. Deliberately conservative: anything uncertain is
 * UNKNOWN, which routes to the capture-with-photo flow rather than blocking
 * the packing session (§3.3).
 */
export function inferItemType(code: string): ItemType {
  const raw = code.trim();
  if (/^\d{15}$/.test(raw) && luhn(raw)) return 'IMEI';
  if (/^\d{19,20}$/.test(raw) && raw.startsWith('89') && luhn(raw)) return 'ICCID';
  if (/^\d{12,14}$/.test(raw)) return 'SKU'; // UPC-A / EAN-13 / ITF-14
  return 'UNKNOWN';
}

/** Quantity rules follow the item type, not the caller's intent. */
export function maxQuantity(type: ItemType): number {
  return isSerialized(type) ? 1 : Number.MAX_SAFE_INTEGER;
}
