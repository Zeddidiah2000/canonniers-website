/**
 * Resolve role and teams via call to canonniers-auth-worker.
 *
 * Matches admin-photos pattern exactly: plain ?email=X query, no auth header.
 * Auth-worker is intentionally open in current architecture — Cloudflare Access
 * gates the admin pages upstream, and any caller (browser, Worker) can resolve
 * an arbitrary email to a role/teams response. This is acceptable because:
 *   1. The auth-worker only returns role/teams data, no PII or secrets
 *   2. The cards-worker has already verified the JWT and extracted a real email
 *   3. Adding service-token gating to auth-worker would break admin-photos and
 *      is a separate, system-wide hardening concern (see backlog).
 */

import type { Env, AuthContext } from './types';

export async function resolveRole(email: string, env: Env): Promise<AuthContext> {
  if (!email) throw new Error('Email required');

  // Use service binding — same-account workers.dev fetch is blocked at CF routing layer
  const url = new URL('https://internal/');
  url.searchParams.set('email', email);

  const res = await env.AUTH_WORKER.fetch(url.toString());

  if (!res.ok) {
    throw new Error(`Auth worker returned ${res.status}`);
  }

  const body = await res.json() as { role: string; teams: string[] };
  // Expected shape: { role: 'admin'|'coach'|..., teams: ['u15'] | ['*'] | [] }
  if (!body.role || !Array.isArray(body.teams)) {
    throw new Error('Invalid auth-worker response');
  }

  return {
    email,
    role: body.role,
    teams: body.teams,
    isAdmin: body.role === 'admin',
    canAccessTeam: (teamId: string) => body.role === 'admin' || body.teams.includes(teamId),
  };
}
