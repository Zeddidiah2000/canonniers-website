const ALLOWED_WRITE_ORIGINS = new Set([
  'https://canonniersdequebec.ca',
  'https://www.canonniersdequebec.ca',
]);

const AUTH_WORKER_URL = 'https://canonniers-auth-worker.chisholm2000.workers.dev';

const READ_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const VALID_TEAMS = new Set(['u15', 'u17d1', 'u17d2']);
const VALID_TYPES = new Set(['game', 'practice', 'team_event', 'tournament', 'other']);
const MAX_FILE_SIZE = 15_728_640; // 15 MB exactly — matches §5.3 per-file upload limit
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function writeCors(request) {
  const origin = request.headers.get('Origin') || '';
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  if (ALLOWED_WRITE_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

function cfImagesBase(env) {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/images/v1`;
}

async function checkRateLimit(env, request) {
  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const { success } = await env.UPLOAD_LIMITER.limit({ key: ip });
  return success;
}

// ── IDENTITY RESOLUTION ────────────────────────────────────────────────────────

async function getCallerIdentity(request, env) {
  if (request._cachedIdentity) return request._cachedIdentity;

  // Step 1: bearer check
  if (request.headers.get('Authorization') !== `Bearer ${env.PHOTO_UPLOAD_TOKEN}`) {
    return { ok: false, status: 401, reason: 'missing or invalid bearer token' };
  }

  // Step 2: JWT presence + payload extraction (trust-without-verify — CF edge validates
  //   before reaching this worker on the canonniersdequebec.ca path)
  const jwt = request.headers.get('CF-Access-Jwt-Assertion');
  if (!jwt) {
    return { ok: false, status: 401, reason: 'missing CF-Access-Jwt-Assertion' };
  }

  let email;
  try {
    // JWT uses base64url — restore standard base64 padding before atob
    const b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)));
    if (payload.exp && payload.exp * 1000 < Date.now()) throw new Error('JWT expired');
    email = payload.email;
    if (!email || typeof email !== 'string') throw new Error('no email in payload');
  } catch {
    return { ok: false, status: 401, reason: 'invalid or unreadable JWT' };
  }

  // Step 3: role/teams lookup via auth-worker
  let role, teams;
  try {
    const r = await fetch(`${AUTH_WORKER_URL}/?email=${encodeURIComponent(email)}`);
    if (!r.ok) throw new Error(`auth-worker HTTP ${r.status}`);
    ({ role, teams } = await r.json());
  } catch (e) {
    console.error('[getCallerIdentity] auth-worker lookup failed:', e.message);
    return { ok: false, status: 502, reason: 'auth lookup failed' };
  }

  // Step 4: role guard
  if (!role || role === 'unknown' || !teams?.length) {
    return { ok: false, status: 403, reason: 'no role assigned' };
  }

  const result = { ok: true, email, role, teams };
  request._cachedIdentity = result;
  return result;
}

function callerCanWriteTeam(identity, team) {
  if (identity.role === 'admin') return true;
  return identity.teams.includes(team);
}

// ── ROUTER ─────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // Preflight — determine CORS from the requested method, not the route
    if (method === 'OPTIONS') {
      const reqMethod = (request.headers.get('Access-Control-Request-Method') || 'GET').toUpperCase();
      const isWrite = ['POST', 'DELETE', 'PATCH', 'PUT'].includes(reqMethod);
      return new Response(null, {
        status: 204,
        headers: {
          ...(isWrite ? writeCors(request) : READ_CORS),
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const isPublicGet = pathname === '/api/photos' && method === 'GET';
    const cors = isPublicGet ? READ_CORS : writeCors(request);

    try {
      if (isPublicGet) {
        return handleGetPhotos(url, env);
      }

      if (pathname === '/api/upload-url' && method === 'POST') {
        if (!await checkRateLimit(env, request)) {
          return new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '60', ...cors } });
        }
        return handleUploadUrl(request, env, cors);
      }

      if (pathname === '/api/photos' && method === 'POST') {
        if (!await checkRateLimit(env, request)) {
          return new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '60', ...cors } });
        }
        return handleCreatePhoto(request, env, cors);
      }

      const deleteMatch = pathname.match(/^\/api\/photos\/(\d+)$/);
      if (deleteMatch && method === 'DELETE') {
        return handleDeletePhoto(request, env, cors, deleteMatch[1]);
      }

      return new Response('Not Found', { status: 404, headers: cors });
    } catch (e) {
      console.error(e.stack);
      return json({ error: 'Internal server error' }, 500, cors);
    }
  },
};

// ── GET /api/photos ─────────────────────────────────────────────────────────────
// Unauthenticated — public gallery reads

async function handleGetPhotos(url, env) {
  const team = url.searchParams.get('team');
  const type = url.searchParams.get('type');
  const from = url.searchParams.get('from');
  const to   = url.searchParams.get('to');

  if (!team || !VALID_TEAMS.has(team)) {
    return json({ error: 'team is required: u15, u17d1, or u17d2' }, 400, READ_CORS);
  }
  if (type && !VALID_TYPES.has(type)) {
    return json({ error: 'Invalid type' }, 400, READ_CORS);
  }

  const conditions = ['is_published = 1', 'team_category = ?'];
  const params = [team];

  if (type) { conditions.push('event_type = ?');  params.push(type); }
  if (from) { conditions.push('event_date >= ?'); params.push(from); }
  if (to)   { conditions.push('event_date <= ?'); params.push(to);   }

  const { results } = await env.DB.prepare(
    `SELECT * FROM photos WHERE ${conditions.join(' AND ')} ORDER BY event_date DESC, id ASC`
  ).bind(...params).all();

  return json({ photos: results }, 200, READ_CORS);
}

// ── POST /api/upload-url ────────────────────────────────────────────────────────

async function handleUploadUrl(request, env, cors) {
  const identity = await getCallerIdentity(request, env);
  if (!identity.ok) return new Response(identity.reason, { status: identity.status, headers: cors });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, cors); }

  const { team, event_date } = body;

  if (!team || !VALID_TEAMS.has(team)) {
    return json({ error: 'team must be u15, u17d1, or u17d2' }, 400, cors);
  }
  if (!callerCanWriteTeam(identity, team)) {
    return new Response('Forbidden: team mismatch', { status: 403, headers: cors });
  }
  if (!event_date || !/^\d{4}-\d{2}-\d{2}$/.test(event_date)) {
    return json({ error: 'event_date must be YYYY-MM-DD' }, 400, cors);
  }

  const cfRes = await fetch(`${cfImagesBase(env)}/direct_upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.CF_IMAGES_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      metadata: { uploader: 'photo-worker', team, event_date },
    }),
  });

  const cfData = await cfRes.json();
  if (!cfData.success) {
    console.error('CF Images direct_upload error:', JSON.stringify(cfData.errors));
    return json({ error: 'Failed to request upload URL' }, 502, cors);
  }

  return json({ uploadURL: cfData.result.uploadURL, id: cfData.result.id }, 200, cors);
}

// ── POST /api/photos ────────────────────────────────────────────────────────────

async function handleCreatePhoto(request, env, cors) {
  const identity = await getCallerIdentity(request, env);
  if (!identity.ok) return new Response(identity.reason, { status: identity.status, headers: cors });

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, cors); }

  let {
    cf_image_id, team_category, event_type, event_name_fr, event_date,
    caption_fr, caption_en, file_size_bytes,
  } = body;

  // Non-admin: ignore client-supplied team_category, derive from identity (zero-trust)
  if (identity.role !== 'admin') {
    team_category = identity.teams[0];
  }

  if (!cf_image_id || !UUID_REGEX.test(cf_image_id))
    return json({ error: 'cf_image_id must be a valid UUID' }, 400, cors);
  if (!team_category || !VALID_TEAMS.has(team_category))
    return json({ error: 'team_category must be u15, u17d1, or u17d2' }, 400, cors);
  if (!callerCanWriteTeam(identity, team_category)) {  // admin-only check (non-admin team is forced above)
    return new Response('Forbidden: team mismatch', { status: 403, headers: cors });
  }
  if (!event_type || !VALID_TYPES.has(event_type))
    return json({ error: 'event_type must be game, practice, team_event, tournament, or other' }, 400, cors);
  if (!event_name_fr || typeof event_name_fr !== 'string' || event_name_fr.length > 100)
    return json({ error: 'event_name_fr required, max 100 chars' }, 400, cors);
  if (!event_date || !/^\d{4}-\d{2}-\d{2}$/.test(event_date))
    return json({ error: 'event_date must be YYYY-MM-DD' }, 400, cors);

  let validatedSize = null;
  if (file_size_bytes != null) {
    const sz = Number(file_size_bytes);
    if (!Number.isInteger(sz) || sz <= 0 || sz >= MAX_FILE_SIZE) {
      return json({ error: 'file_size_bytes must be a positive integer less than 15 MB' }, 400, cors);
    }
    validatedSize = sz;
  }

  // width/height/mime_type may be null if CF Images is still processing or metadata fetch fails.
  // Non-fatal: gallery degrades CLS for affected photos until backfill.
  let width = null, height = null, mime_type = null;
  try {
    const cfRes = await fetch(`${cfImagesBase(env)}/${cf_image_id}`, {
      headers: { 'Authorization': `Bearer ${env.CF_IMAGES_TOKEN}` },
    });
    if (cfRes.ok) {
      const cfData = await cfRes.json();
      if (cfData.success && cfData.result) {
        const r = cfData.result;
        width     = r.width    ?? r.meta?.width    ?? null;
        height    = r.height   ?? r.meta?.height   ?? null;
        mime_type = r.mimeType ?? r.mime_type      ?? null;
      }
    }
  } catch (e) {
    console.error('CF Images metadata fetch failed:', e.message);
  }

  await env.DB.prepare(`
    INSERT INTO photos
      (cf_image_id, team_category, event_type, event_name_fr, event_date,
       width, height, file_size_bytes, mime_type, caption_fr, caption_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    cf_image_id, team_category, event_type, event_name_fr, event_date,
    width, height, validatedSize, mime_type,
    caption_fr || null, caption_en || null,
  ).run();

  return json({ ok: true }, 200, cors);
}

// ── DELETE /api/photos/:id ──────────────────────────────────────────────────────

async function handleDeletePhoto(request, env, cors, idStr) {
  // Steps 1–4: bearer + JWT + auth-worker + role guard (all inside getCallerIdentity)
  const identity = await getCallerIdentity(request, env);
  if (!identity.ok) return new Response(identity.reason, { status: identity.status, headers: cors });

  // Step 5: validate id
  const id = parseInt(idStr, 10);
  if (!Number.isInteger(id) || id < 1) {
    return json({ error: 'invalid id' }, 400, cors);
  }

  // Step 6: fetch photo row — 404 is idempotent (already deleted is fine)
  const photo = await env.DB.prepare(
    'SELECT id, cf_image_id, team_category FROM photos WHERE id = ?'
  ).bind(id).first();

  if (!photo) {
    return json({ deleted: false, reason: 'not found' }, 404, cors);
  }

  // Step 7: team RBAC
  if (!callerCanWriteTeam(identity, photo.team_category)) {
    return new Response('Forbidden: team mismatch', { status: 403, headers: cors });
  }

  // Step 8: delete D1 row first — abort on failure, do NOT proceed to CF delete
  try {
    await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(id).run();
  } catch (e) {
    console.error(`[delete-photo] D1 delete failed id=${id}:`, e.message);
    return json({ error: 'database error' }, 500, cors);
  }

  // Step 9: delete CF Images asset — best-effort, D1 is source of truth for gallery
  let cfStatus = 'deleted';
  try {
    const r = await fetch(`${cfImagesBase(env)}/${photo.cf_image_id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${env.CF_IMAGES_TOKEN}` },
    });
    if (!r.ok) {
      cfStatus = `cf_failed_${r.status}`;
      console.warn(`[delete-photo] CF Images delete failed for ${photo.cf_image_id}: HTTP ${r.status}`);
    }
  } catch (e) {
    cfStatus = 'cf_network_error';
    console.warn(`[delete-photo] CF Images delete error for ${photo.cf_image_id}:`, e.message);
  }

  // Step 10
  return json({ deleted: true, id, cf_status: cfStatus }, 200, cors);
}
