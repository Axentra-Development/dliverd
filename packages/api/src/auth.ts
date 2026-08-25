import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { can, type Action, type Principal, type Resource, type Role } from '@custode/core';

/**
 * Authentication and authorisation at the edge (spec §4.1, §6.4).
 *
 * Keys are 256-bit random values; a plain SHA-256 lookup hash is the standard
 * treatment for high-entropy tokens (stretching KDFs exist to protect
 * low-entropy secrets). The plaintext is shown once at issuance, never stored.
 */

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface AuthedPrincipal {
  principal: Principal;
  /** Resolved display details for ledger attribution. */
  actor: { user_id: string | null; role: string; label: string };
  provider_id: string | null;
  store_id: string | null;
}

export async function resolveApiKey(pool: pg.Pool, key: string): Promise<AuthedPrincipal | null> {
  const { rows } = await pool.query(
    `SELECT k.id AS key_id, k.user_id, k.provider_id AS key_provider_id, k.label,
            u.role, u.display_name, u.provider_id AS user_provider_id, u.store_id, u.status
       FROM custode.api_key k
       LEFT JOIN custode.app_user u ON u.id = k.user_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
    [sha256(key)],
  );
  const r = rows[0];
  if (!r) return null;

  if (r.user_id) {
    if (r.status !== 'ACTIVE') return null;
    const role = r.role as Role;
    return {
      principal: {
        kind: 'user',
        user_id: r.user_id,
        role,
        provider_id: r.user_provider_id ?? undefined,
        store_id: r.store_id ?? undefined,
      },
      actor: { user_id: r.user_id, role, label: r.display_name },
      provider_id: r.user_provider_id,
      store_id: r.store_id,
    };
  }
  return {
    principal: { kind: 'api_key', key_id: r.key_id, provider_id: r.key_provider_id },
    actor: { user_id: null, role: 'PROVIDER_API', label: r.label },
    provider_id: r.key_provider_id,
    store_id: null,
  };
}

// ---------------------------------------------------------------------------
// Fastify glue
// ---------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthedPrincipal;
  }
}

function problemBody(status: number, code: string, detail: string, extra: Record<string, unknown>) {
  return {
    type: `https://api.custode.ca/errors/${code}`,
    title: code.replace(/_/g, ' '),
    status, code, detail, ...extra,
  };
}

/**
 * Route-handler variant: sets status and RETURNS the body without sending, so
 * the response goes out only after the handler's transaction has committed.
 * Sending from inside the transaction is a race — a client can read the API's
 * answer before the database agrees with it.
 */
export function problem(
  reply: FastifyReply,
  status: number,
  code: string,
  detail: string,
  extra: Record<string, unknown> = {},
) {
  reply.status(status).type('application/problem+json');
  return problemBody(status, code, detail, extra);
}

/** Hook variant: sends immediately to short-circuit the request. */
export function problemSend(
  reply: FastifyReply,
  status: number,
  code: string,
  detail: string,
  extra: Record<string, unknown> = {},
) {
  return reply.status(status).type('application/problem+json')
    .send(problemBody(status, code, detail, extra));
}

export function requireAuth(pool: pg.Pool) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string' || !key) {
      return problemSend(reply, 401, 'missing_api_key', 'Provide x-api-key.');
    }
    const auth = await resolveApiKey(pool, key);
    if (!auth) return problemSend(reply, 401, 'invalid_api_key', 'Unknown or revoked key.');
    req.auth = auth;
  };
}

/**
 * Server-side enforcement of the §0.5 matrix. Hiding a panel is not a
 * permission; every route consults this.
 *
 * Denials carry no count, no hash and no hint — a STORE_REP probing the ledger
 * learns only that the door is closed (§6.5).
 */
export function requires(action: Action, res?: (req: FastifyRequest) => Resource) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!can(req.auth.principal, action, res?.(req))) {
      return problemSend(reply, 403, 'forbidden', 'Not permitted for this principal.');
    }
  };
}
