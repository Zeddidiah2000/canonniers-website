/**
 * canonniers-live-scorebug-worker
 *
 * KV-only worker that backs the public scorebug overlay rendered by
 * /scorebug.html (loaded as a browser source in golightstream.com / burned by
 * the VPS relay via overlay-broadcast.html) and driven by
 * /admin-scorekeeper.html (CF Access gated phone control) and the VPS
 * gc-poller (bearer token).
 *
 * Endpoints:
 *   OPTIONS /api/scorebug/*             — CORS preflight
 *   GET     /api/scorebug/u15           — public live state from KV (404 if absent);
 *                                         overlay_scale injected from the durable key
 *   PUT     /api/scorebug/u15           — CF Access JWT OR poller bearer, writes to KV
 *   DELETE  /api/scorebug/u15           — CF Access JWT OR poller bearer, clears state
 *   PUT     /api/scorebug/u15/scale     — CF Access JWT OR poller bearer, durable overlay size
 *   GET     /api/scorebug/u15/scale     — public, current overlay size (default 1)
 *   PUT     /api/scorebug/u15/gctoken   — CF Access only (Jay pastes the GC session token)
 *   GET     /api/scorebug/u15/gctoken   — poller bearer → full record;
 *                                         CF Access → metadata only (saved_at, no token)
 *   DELETE  /api/scorebug/u15/gctoken   — CF Access JWT OR poller bearer, clears token
 *   GET     /health                     — liveness
 */

import { verifyAccessJwt } from './auth';
import { validateState } from './validate';
import { getOpponents } from './teams';
import type { Env, GcTokenRecord, ScoreState } from './types';

const ALLOWED_EMAILS = new Set<string>([
  'jay@canonniers.ca',
  // add coaches here as they need scorekeeping access
]);

const ALLOWED_TEAMS = new Set(['u15']);
const KV_TTL_HOURS = 6;
const GCTOKEN_TTL_HOURS = 24;

function cors(env: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, cf-access-jwt-assertion, Cf-Access-Jwt-Assertion',
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

function gcTokenKey(team: string): string {
  return `gctoken:${team}`;
}

// Durable overlay-size key — its OWN KV entry with NO TTL, so the scale Jay
// dials survives every per-game state clear / expiry (the whole point of #3).
function scaleKey(team: string): string {
  return `scale:${team}`;
}

// Read the durable scale (clamped) or null if unset/corrupt. Stored as
// { overlay_scale, updated_at }; also tolerates a bare number for forward-compat.
async function readScale(team: string, env: Env): Promise<number | null> {
  const raw = await env.SCOREBUG.get(scaleKey(team));
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    const v = typeof o === 'number' ? o : (o && (o as Record<string, unknown>).overlay_scale);
    if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0.5, Math.min(2, v));
  } catch { /* corrupt */ }
  return null;
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

    // Commentary feed (voice play-by-play v0): /api/scorebug/{team}/commentary
    const cm = url.pathname.match(/^\/api\/scorebug\/([a-z0-9]+)\/commentary$/i);
    if (cm) {
      const team = cm[1].toLowerCase();
      if (!ALLOWED_TEAMS.has(team)) return json({ error: 'unknown_team' }, 404, env);
      if (request.method === 'GET') return handleCommentaryGet(team, env);
      if (request.method === 'PUT') return handleCommentaryPut(team, request, env);
      return json({ error: 'method_not_allowed' }, 405, env);
    }

    // Durable overlay scale: /api/scorebug/{team}/scale
    const sc = url.pathname.match(/^\/api\/scorebug\/([a-z0-9]+)\/scale$/i);
    if (sc) {
      const team = sc[1].toLowerCase();
      if (!ALLOWED_TEAMS.has(team)) return json({ error: 'unknown_team' }, 404, env);
      if (request.method === 'PUT') return handleScalePut(team, request, env);
      if (request.method === 'GET') return handleScaleGet(team, env);
      return json({ error: 'method_not_allowed' }, 405, env);
    }

    // GC session token vault: /api/scorebug/{team}/gctoken
    const gt = url.pathname.match(/^\/api\/scorebug\/([a-z0-9]+)\/gctoken$/i);
    if (gt) {
      const team = gt[1].toLowerCase();
      if (!ALLOWED_TEAMS.has(team)) return json({ error: 'unknown_team' }, 404, env);
      if (request.method === 'PUT')    return handleGcTokenPut(team, request, env);
      if (request.method === 'GET')    return handleGcTokenGet(team, request, env);
      if (request.method === 'DELETE') return handleGcTokenDelete(team, request, env);
      return json({ error: 'method_not_allowed' }, 405, env);
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
  // Overlay size is authoritative from the durable scale:{team} key, injected
  // here so every consumer (scorebug.html burn, phone, poller) sees the current
  // size without it living in — and dying with — the per-game state. If the
  // durable key is unset we leave the state's own value (backward compatible).
  let body = raw;
  const scale = await readScale(team, env);
  if (scale != null) {
    try {
      const s = JSON.parse(raw) as Record<string, unknown>;
      s.overlay_scale = scale;
      body = JSON.stringify(s);
    } catch { /* corrupt state — return as-is */ }
  }
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      ...cors(env),
    },
  });
}

/* ── DURABLE OVERLAY SCALE ────────────────────────────────────────────── */
// Its own KV key (no TTL) so the size survives state clears; changing it does
// NOT touch the per-game state's mode, so the phone can resize the live burn
// without flipping the poller to manual.

async function handleScalePut(team: string, request: Request, env: Env): Promise<Response> {
  const gate = await authGate(request, env);
  if (gate) return gate;

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return json({ error: 'bad_request', detail: 'Content-Type must be application/json' }, 400, env);
  }
  const text = await request.text();
  if (text.length > 256) return json({ error: 'payload_too_large' }, 413, env);

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { return json({ error: 'bad_json' }, 400, env); }

  const v = parsed.overlay_scale;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return json({ error: 'validation_failed', detail: 'overlay_scale: required finite number' }, 400, env);
  }
  const scale = Math.max(0.5, Math.min(2, v));
  await env.SCOREBUG.put(scaleKey(team), JSON.stringify({ overlay_scale: scale, updated_at: new Date().toISOString() }));
  return json({ ok: true, overlay_scale: scale }, 200, env);
}

async function handleScaleGet(team: string, env: Env): Promise<Response> {
  const scale = await readScale(team, env);
  return json({ overlay_scale: scale ?? 1 }, 200, env);
}

/* ── AUTH ─────────────────────────────────────────────────────────────── */

// Bearer door for the VPS gc-poller. Constant-time compare not required for a
// 256-bit random secret, but avoid leaking length via early exit anyway.
function hasPollerBearer(request: Request, env: Env): boolean {
  if (!env.POLLER_TOKEN) return false;
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const presented = m[1].trim();
  if (presented.length !== env.POLLER_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ env.POLLER_TOKEN.charCodeAt(i);
  }
  return diff === 0;
}

// CF Access JWT + email allowlist (humans). Returns an error Response or null.
async function accessGate(request: Request, env: Env): Promise<Response | null> {
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

// Humans (CF Access) OR the poller bearer.
async function authGate(request: Request, env: Env): Promise<Response | null> {
  if (hasPollerBearer(request, env)) return null;
  return accessGate(request, env);
}

/* ── SCORE STATE ──────────────────────────────────────────────────────── */

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

/* ── GC TOKEN VAULT ───────────────────────────────────────────────────── */

// PUT is CF Access ONLY — the poller never writes the token, and the bearer
// must not be able to plant one.
async function handleGcTokenPut(team: string, request: Request, env: Env): Promise<Response> {
  const gate = await accessGate(request, env);
  if (gate) return gate;

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return json({ error: 'bad_request', detail: 'Content-Type must be application/json' }, 400, env);
  }
  const text = await request.text();
  if (text.length > 16384) {
    return json({ error: 'payload_too_large' }, 413, env);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return json({ error: 'bad_json' }, 400, env);
  }

  const token = typeof parsed.token === 'string' ? parsed.token.trim() : '';
  if (token.length < 20 || token.length > 8192) {
    return json({ error: 'validation_failed', detail: 'token: required string (20–8192 chars)' }, 400, env);
  }
  const strOpt = (v: unknown, max: number): string | null =>
    (typeof v === 'string' && v.trim() && v.length <= max) ? v.trim() : null;

  const record: GcTokenRecord = {
    token,
    device_id: strOpt(parsed.device_id, 200),
    waf_token: strOpt(parsed.waf_token, 4096),
    saved_at: new Date().toISOString(),
  };

  await env.SCOREBUG.put(gcTokenKey(team), JSON.stringify(record), {
    expirationTtl: GCTOKEN_TTL_HOURS * 3600,
  });

  return json({ ok: true, saved_at: record.saved_at }, 200, env);
}

// GET: the poller bearer receives the full record. CF Access humans get the
// metadata only (saved_at) so the page can show token age — the token itself
// never travels back to a browser.
async function handleGcTokenGet(team: string, request: Request, env: Env): Promise<Response> {
  const isPoller = hasPollerBearer(request, env);
  if (!isPoller) {
    const gate = await accessGate(request, env);
    if (gate) return gate;
  }

  const raw = await env.SCOREBUG.get(gcTokenKey(team));
  if (!raw) return json({ error: 'no_token' }, 404, env);

  if (isPoller) {
    return new Response(raw, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        ...cors(env),
      },
    });
  }

  let saved_at: string | null = null;
  try { saved_at = (JSON.parse(raw) as GcTokenRecord).saved_at || null; } catch { /* corrupt */ }
  return json({ saved_at }, 200, env);
}

async function handleGcTokenDelete(team: string, request: Request, env: Env): Promise<Response> {
  const gate = await authGate(request, env);
  if (gate) return gate;
  await env.SCOREBUG.delete(gcTokenKey(team));
  return json({ ok: true, cleared: true }, 200, env);
}

/* ── COMMENTARY FEED (voice play-by-play v0) ──────────────────────────── */
// Rolling window of recent play-by-play lines, written by the gc-poller and
// read (public) by teststream.html, which speaks new lines via the browser's
// SpeechSynthesis. { id (monotonic play order), fr, en, ts } per line.
const COMMENTARY_TTL_HOURS = 6;
const COMMENTARY_MAX = 40;

function commentaryKey(team: string): string { return `commentary:${team}`; }

async function handleCommentaryGet(team: string, env: Env): Promise<Response> {
  const raw = await env.SCOREBUG.get(commentaryKey(team));
  return new Response(raw || '[]', {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...cors(env),
    },
  });
}

async function handleCommentaryPut(team: string, request: Request, env: Env): Promise<Response> {
  if (!hasPollerBearer(request, env)) {
    const gate = await accessGate(request, env);
    if (gate) return gate;
  }
  const text = await request.text();
  if (text.length > 16384) return json({ error: 'payload_too_large' }, 413, env);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return json({ error: 'bad_json' }, 400, env); }
  if (!Array.isArray(parsed)) return json({ error: 'must be an array' }, 400, env);

  const clean = parsed.slice(-COMMENTARY_MAX).map((l) => {
    const o = (l && typeof l === 'object') ? l as Record<string, unknown> : {};
    const s = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
    return {
      id: Number.isFinite(o.id) ? Math.trunc(o.id as number) : 0,
      fr: s(o.fr, 300),
      en: s(o.en, 300),
      ts: s(o.ts, 40) || new Date().toISOString(),
    };
  });

  await env.SCOREBUG.put(commentaryKey(team), JSON.stringify(clean), {
    expirationTtl: COMMENTARY_TTL_HOURS * 3600,
  });
  return json({ ok: true, count: clean.length }, 200, env);
}
