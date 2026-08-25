import { POLICY, type Cents } from '../domain/types.js';

/**
 * Services, cutoffs and cancellation (spec §3.6, §3.7, §1.9).
 */

export interface Service {
  code: string;
  name: string;
  window_label: string;
  price_cents: Cents;
  /** Cannot be served once the store's cutoff has passed today. */
  morning_only: boolean;
  sort_order: number;
}

/** CUSTODE_24 is sort_order 1 and is the default selection in every booking UI. */
export const SERVICES: readonly Service[] = [
  { code: 'CUSTODE_24',      name: 'CUSTODE 24',      window_label: 'end of day',    price_cents: 1075, morning_only: false, sort_order: 1 },
  { code: 'CUSTODE_24_NOON', name: 'CUSTODE 24 NOON', window_label: 'by 12:00',      price_cents: 1550, morning_only: true,  sort_order: 2 },
  { code: 'CUSTODE_24_AM',   name: 'CUSTODE 24 AM',   window_label: 'by 10:30',      price_cents: 2150, morning_only: true,  sort_order: 3 },
  { code: 'CUSTODE_EVENING', name: 'CUSTODE EVENING', window_label: '17:30–21:00',   price_cents: 2350, morning_only: false, sort_order: 4 },
  { code: 'REPRISE',         name: 'REPRISE',         window_label: 'reverse pickup', price_cents: 975, morning_only: false, sort_order: 5 },
] as const;

export const DEFAULT_SERVICE_CODE = 'CUSTODE_24';

export const serviceByCode = (code: string): Service | undefined =>
  SERVICES.find((s) => s.code === code);

// ---------------------------------------------------------------------------
// Cutoffs
// ---------------------------------------------------------------------------

export interface ServiceAvailability extends Service {
  available: boolean;
  unavailable_reason?: 'cutoff_passed';
}

/** Minutes past local midnight, in the given IANA zone. */
export function localMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return h * 60 + m;
}

export function parseHHMM(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + (m || 0);
}

/**
 * A service past cutoff is returned as unavailable *with its reason*, never
 * omitted. Selling a window you cannot serve is worse than refusing it, and
 * hiding the option makes the refusal look like a bug (§3.7).
 */
export function availableServices(args: {
  at: Date;
  timeZone: string;
  cutoffLocal: string;
  services?: readonly Service[];
}): ServiceAvailability[] {
  const past = localMinutes(args.at, args.timeZone) >= parseHHMM(args.cutoffLocal);
  return [...(args.services ?? SERVICES)]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((s) =>
      s.morning_only && past
        ? { ...s, available: false, unavailable_reason: 'cutoff_passed' as const }
        : { ...s, available: true },
    );
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

export type CancelQuote =
  | { allowed: true; fee_cents: Cents; free_until: Date }
  | { allowed: false; reason: 'in_custody' | 'already_closed'; note?: string };

export function freeCancelUntil(bookedAt: Date): Date {
  return new Date(bookedAt.getTime() + POLICY.freeCancelMinutes * 60_000);
}

export function cancelQuote(mv: { status: string; booked_at: Date }, now: Date): CancelQuote {
  if (['DELIVERED', 'CANCELLED', 'RECALLED'].includes(mv.status)) {
    return { allowed: false, reason: 'already_closed' };
  }
  if (mv.status === 'PICKED_UP') {
    return {
      allowed: false,
      reason: 'in_custody',
      note: 'The visit is payable in full; devices return at the REPRISE rate.',
    };
  }
  const free_until = freeCancelUntil(mv.booked_at);
  return {
    allowed: true,
    fee_cents: now <= free_until ? 0 : POLICY.cancelFeeCents,
    free_until,
  };
}
