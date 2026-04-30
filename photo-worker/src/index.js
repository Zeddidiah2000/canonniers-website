const ALLOWED_WRITE_ORIGINS = new Set([
  'https://canonniersdequebec.ca',
  'https://www.canonniersdequebec.ca',
]);

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

function isAuthed(env, request) {
  return request.headers.get('Authorization') === `Bearer ${env.PHOTO_UPLOAD_TOKEN}`;
}

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
        if (!isAuthed(env, request)) return new Response('Unauthorized', { status: 401, headers: cors });
        return handleUploadUrl(request, env, cors);
      }

      if (pathname === '/api/photos' && method === 'POST') {
        if (!await checkRateLimit(env, request)) {
          return new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '60', ...cors } });
        }
        if (!isAuthed(env, request)) return new Response('Unauthorized', { status: 401, headers: cors });
        return handleCreatePhoto(request, env, cors);
      }

      const deleteMatch = pathname.match(/^\/api\/photos\/(\d+)$/);
      if (deleteMatch && method === 'DELETE') {
        if (!isAuthed(env, request)) return new Response('Unauthorized', { status: 401, headers: cors });
        return handleDeletePhoto(request, env, cors, deleteMatch[1]);
      }

      return new Response('Not Found', { status: 404, headers: cors });
    } catch (e) {
      console.error(e.stack);
      return json({ error: 'Internal server error' }, 500, cors);
    }
  },
};

// ── GET /api/photos ────────────────────────────────────────────────────────────

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

// ── POST /api/upload-url ───────────────────────────────────────────────────────

async function handleUploadUrl(request, env, cors) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, cors); }

  const { team, event_date } = body;

  if (!team || !VALID_TEAMS.has(team)) {
    return json({ error: 'team must be u15, u17d1, or u17d2' }, 400, cors);
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

// ── POST /api/photos ───────────────────────────────────────────────────────────

async function handleCreatePhoto(request, env, cors) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, cors); }

  const {
    cf_image_id, team_category, event_type, event_name_fr, event_date,
    caption_fr, caption_en, file_size_bytes,
  } = body;

  if (!cf_image_id || !UUID_REGEX.test(cf_image_id))
    return json({ error: 'cf_image_id must be a valid UUID' }, 400, cors);
  if (!team_category || !VALID_TEAMS.has(team_category))
    return json({ error: 'team_category must be u15, u17d1, or u17d2' }, 400, cors);
  if (!event_type || !VALID_TYPES.has(event_type))
    return json({ error: 'event_type must be game, practice, team_event, tournament, or other' }, 400, cors);
  if (!event_name_fr || typeof event_name_fr !== 'string' || event_name_fr.length > 100)
    return json({ error: 'event_name_fr required, max 100 chars' }, 400, cors);
  if (!event_date || !/^\d{4}-\d{2}-\d{2}$/.test(event_date))
    return json({ error: 'event_date must be YYYY-MM-DD' }, 400, cors);

  // file_size_bytes: client-provided bookkeeping value, validate range only
  let validatedSize = null;
  if (file_size_bytes != null) {
    const sz = Number(file_size_bytes);
    if (!Number.isInteger(sz) || sz <= 0 || sz >= MAX_FILE_SIZE) {
      return json({ error: 'file_size_bytes must be a positive integer less than 15 MB' }, 400, cors);
    }
    validatedSize = sz;
  }

  // TODO(phase-1.1): width/height/mime_type may end up null in two cases:
  //   1. CF Images metadata fetch threw (caught below) — network/API error
  //   2. CF Images returned 200 but the image is still processing (no exception)
  // Either way, D1 insert proceeds. Backfill cron not yet implemented — see directive §4 notes.
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

// ── DELETE /api/photos/:id ─────────────────────────────────────────────────────

async function handleDeletePhoto(request, env, cors, id) {
  const mode = new URL(request.url).searchParams.get('mode');

  if (mode !== 'unpublish' && mode !== 'purge') {
    return json({ error: 'mode must be unpublish or purge' }, 400, cors);
  }

  const { results } = await env.DB.prepare(
    'SELECT cf_image_id FROM photos WHERE id = ?'
  ).bind(id).all();

  if (!results.length) return json({ error: 'Not found' }, 404, cors);
  const { cf_image_id } = results[0];

  if (mode === 'unpublish') {
    // Break the public imagedelivery.net URL immediately before touching D1
    const patchRes = await fetch(`${cfImagesBase(env)}/${cf_image_id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${env.CF_IMAGES_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requireSignedURLs: true }),
    });
    const patchData = await patchRes.json();
    if (!patchData.success) {
      console.error('CF Images PATCH error:', JSON.stringify(patchData.errors));
      return json({ error: 'Failed to revoke image URL — D1 row unchanged' }, 502, cors);
    }
    await env.DB.prepare('UPDATE photos SET is_published = 0 WHERE id = ?').bind(id).run();
    return json({ ok: true }, 200, cors);
  }

  // purge — fail closed: CF Images binary must be gone before D1 row is removed
  const delRes = await fetch(`${cfImagesBase(env)}/${cf_image_id}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${env.CF_IMAGES_TOKEN}` },
  });
  const delData = await delRes.json();
  if (!delData.success) {
    console.error('CF Images DELETE error:', JSON.stringify(delData.errors));
    return json({ error: 'CF Images delete failed — D1 row unchanged, retry safe' }, 502, cors);
  }

  try {
    await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(id).run();
  } catch (e) {
    console.error(`ORPHAN cf_image_id=${cf_image_id} — deleted from CF Images but D1 delete failed: ${e.message}`);
    return json({ error: 'D1 delete failed after CF Images delete — orphan logged', cf_image_id }, 500, cors);
  }

  return json({ ok: true }, 200, cors);
}
