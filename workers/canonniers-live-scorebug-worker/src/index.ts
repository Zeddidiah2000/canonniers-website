/**
 * canonniers-live-scorebug-worker
 *
 * KV-only worker that backs the public scorebug overlay rendered by
 * /scorebug.html (loaded as a browser source in golightstream.com) and
 * driven by /admin-scorekeeper.html (CF Access gated phone control).
 *
 * Endpoints:
 *   OPTIONS /api/scorebug/*       — CORS preflight
 *   GET     /api/scorebug/u15     — public live state from KV (404 if absent)
 *   PUT     /api/scorebug/u15     — JWT + email allowlist, writes to KV
 *   DELETE  /api/scorebug/u15     — JWT + email allowlist, clears state
 *   GET     /health               — liveness
 */

import { verifyAccessJwt } from './auth';
import { validateState } from './validate';
import { getOpponents } from './teams';
import type { Env, ScoreState } from './types';

const ALLOWED_EMAILS = new Set<string>([
  'jay@canonniers.ca',
  // add coaches here as they need scorekeeping access
]);

const ALLOWED_TEAMS = new Set(['u15']);
const KV_TTL_HOURS = 6;

function cors(env: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, cf-access-jwt-assertion, Cf-Access-Jwt-Assertion',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body: unknown, status: number, env: Env, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...cors(env),
      ...extraHeaders,
    },
  });
}

function kvKey(team: string): string {
  return `current:${team}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(env) });
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ status: 'ok' }, 200, env);
    }

    // Opponent picker: GET /api/scorebug/teams?team=u15
    if (url.pathname === '/api/scorebug/teams' && request.method === 'GET') {
      const team = (url.searchParams.get('team') || 'u15').toLowerCase();
      if (!ALLOWED_TEAMS.has(team)) return json({ error: 'unknown_team' }, 404, env);
      const opponents = await getOpponents(env, team);
      return new Response(JSON.stringify(opponents), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
          ...cors(env),
        },
      });
    }

    const m = url.pathname.match(/^\/api\/scorebug\/([a-z0-9]+)$/i);
    if (!m) return json({ error: 'not_found' }, 404, env);

    const team = m[1].toLowerCase();
    if (!ALLOWED_TEAMS.has(team)) return json({ error: 'unknown_team' }, 404, env);

    if (request.method === 'GET') {
      return handleGet(team, env);
    }
    if (request.method === 'PUT') {
      return handlePut(team, request, env);
    }
    if (request.method === 'DELETE') {
      return handleDelete(team, request, env);
    }
    return json({ error: 'method_not_allowed' }, 405, env);
  }
};

async function handleGet(team: string, env: Env): Promise<Response> {
  const raw = await env.SCOREBUG.get(kvKey(team));
  if (!raw) return json({ error: 'no_active_state' }, 404, env);
  return new Response(raw, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      ...cors(env),
    },
  });
}

async function authGate(request: Request, env: Env): Promise<Response | null> {
  let identity;
  try {
    identity = await verifyAccessJwt(request, env);
  } catch (e) {
    return json({ error: 'unauthorized', detail: (e as Error).message }, 401, env);
  }
  const email = (identity.email || '').toLowerCase().trim();
  if (!ALLOWED_EMAILS.has(email)) {
    return json({ error: 'forbidden' }, 403, env);
  }
  return null;
}

async function handlePut(team: string, request: Request, env: Env): Promise<Response> {
  const gate = await authGate(request, env);
  if (gate) return gate;

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return json({ error: 'bad_request', detail: 'Content-Type must be application/json' }, 400, env);
  }
  const text = await request.text();
  if (text.length > 4096) {
    return json({ error: 'payload_too_large' }, 413, env);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json({ error: 'bad_json' }, 400, env);
  }

  let clean: Omit<ScoreState, 'updated_at' | 'version'>;
  try {
    clean = validateState(parsed);
  } catch (e) {
    return json({ error: 'validation_failed', detail: (e as Error).message }, 400, env);
  }

  const state: ScoreState = {
    ...clean,
    updated_at: new Date().toISOString(),
    version: 1,
  };

  await env.SCOREBUG.put(kvKey(team), JSON.stringify(state), {
    expirationTtl: KV_TTL_HOURS * 3600,
  });

  return json({ ok: true, updated_at: state.updated_at }, 200, env);
}

async function handleDelete(team: string, request: Request, env: Env): Promise<Response> {
  const gate = await authGate(request, env);
  if (gate) return gate;
  await env.SCOREBUG.delete(kvKey(team));
  return json({ ok: true, cleared: true }, 200, env);
}
