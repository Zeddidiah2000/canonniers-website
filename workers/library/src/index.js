// canonniers-library-worker
// Auth: Bearer LIBRARY_TOKEN + X-User-Email header. Token checked against LIBRARY_TOKEN secret.
// Role looked up via AUTH_WORKER service binding (same pattern as roster worker).
//
// Pre-flight adaptations (2026-05-12):
//   - assign-player: uses flat R2 key player_<id>.<ext>, URL /api/photos/player_<id>.<ext>
//     (roster worker serves /api/photos/:filename via .pop() — subdirectory keys break it)
//   - push-to-gallery: uploads to CF Images (photos table uses cf_image_id + team_category,
//     not r2_key + team — verified against live D1 schema before commit)

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_BATCH_FILES = 50;
const ALLOWED_TEAMS = new Set(['u15', 'u17d1', 'u17d2']);
const VALID_EVENT_TYPES = new Set(['game', 'practice', 'team_event', 'tournament', 'other']);

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || 'https://canonniersdequebec.ca',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Email',
    'Vary': 'Origin',
  };
}

function json(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

async function getCallerIdentity(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || auth !== `Bearer ${env.LIBRARY_TOKEN}`) return null;
  const email = (request.headers.get('X-User-Email') || '').toLowerCase().trim();
  if (!email || !email.includes('@')) return null;
  // Service binding — NOT fetch (inter-worker fetch is blocked on same CF account)
  const resp = await env.AUTH_WORKER.fetch(`https://auth/?email=${encodeURIComponent(email)}`);
  if (!resp.ok) return null;
  const identity = await resp.json();
  if (!identity.role) return null;
  return { email, role: identity.role, teams: identity.teams || [] };
}

function sanitizeText(s, maxLen = 200) {
  if (!s) return null;
  // Latin-1 supplement included for French accented chars (é, è, à, ç, …)
  const cleaned = String(s).replace(/[^A-Za-zÀ-ÿ0-9._\- ]/g, '').slice(0, maxLen).trim();
  return cleaned || null;
}

async function sniffMime(bytes) {
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

function pickerFilter(callerTeams, role) {
  if (role === 'admin') return { sql: '1=1', params: [] };
  const teamConditions = callerTeams.map(() => `linked_teams LIKE ?`).join(' OR ');
  const params = callerTeams.map(t => `%"${t}"%`);
  return {
    sql: `(linked_teams IS NULL OR ${teamConditions})`,
    params,
  };
}

async function handleUpload(request, env, caller, origin) {
  const form = await request.formData();
  const files = form.getAll('files');
  if (files.length === 0) return json({ error: 'No files' }, 400, origin);
  if (files.length > MAX_BATCH_FILES) {
    return json({ error: `Batch limit ${MAX_BATCH_FILES}` }, 400, origin);
  }

  const results = [];
  for (const file of files) {
    if (!(file instanceof File)) {
      results.push({ ok: false, error: 'Not a file' });
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      results.push({ ok: false, filename: file.name, error: 'Too large' });
      continue;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sniffed = await sniffMime(bytes);
    if (!sniffed || !ALLOWED_MIME.has(sniffed)) {
      results.push({ ok: false, filename: file.name, error: 'Invalid MIME' });
      continue;
    }

    // Thumbnail must be sent alongside original by the caller (bootstrap script or browser)
    const thumbBlob = form.get(`thumb_${file.name}`);
    if (!thumbBlob || !(thumbBlob instanceof File)) {
      results.push({ ok: false, filename: file.name, error: 'Missing thumbnail' });
      continue;
    }
    const thumbBytes = new Uint8Array(await thumbBlob.arrayBuffer());

    const id  = crypto.randomUUID();
    const ext = sniffed === 'image/jpeg' ? 'jpg' : sniffed === 'image/png' ? 'png' : 'webp';
    const r2Key      = `library/${id}.${ext}`;
    const thumbR2Key = `library/${id}_thumb.jpg`;

    await env.LIBRARY.put(r2Key, bytes, { httpMetadata: { contentType: sniffed } });
    await env.LIBRARY.put(thumbR2Key, thumbBytes, { httpMetadata: { contentType: 'image/jpeg' } });

    const cleanFilename = sanitizeText(file.name, 200);
    const insert = await env.DB.prepare(
      `INSERT INTO photo_library (r2_key, thumb_r2_key, filename, size_bytes, mime_type, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(r2Key, thumbR2Key, cleanFilename, file.size, sniffed, caller.email).run();

    results.push({ ok: true, id: insert.meta.last_row_id, filename: cleanFilename });
  }
  return json({ results }, 200, origin);
}

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const caller = await getCallerIdentity(request, env);
    if (!caller) return json({ error: 'Unauthorized' }, 401, origin);

    try {
      // ── GET /api/library ─────────────────────────────────────────
      if (url.pathname === '/api/library' && request.method === 'GET') {
        const filter = url.searchParams.get('filter') || 'all';
        let where = '1=1';
        const params = [];

        if (filter === 'unsorted') {
          where = 'linked_teams IS NULL';
        } else if (ALLOWED_TEAMS.has(filter)) {
          if (caller.role !== 'admin' && !caller.teams.includes(filter)) {
            return json({ error: 'Forbidden' }, 403, origin);
          }
          where = 'linked_teams LIKE ?';
          params.push(`%"${filter}"%`);
        } else if (filter === 'all') {
          if (caller.role !== 'admin') {
            const pf = pickerFilter(caller.teams, caller.role);
            where = pf.sql;
            params.push(...pf.params);
          }
        }

        const rows = await env.DB.prepare(
          `SELECT id, r2_key, thumb_r2_key, filename, size_bytes, width, height, mime_type,
                  uploaded_by, uploaded_at, linked_teams, linked_player_ids,
                  first_linked_at, last_linked_at, pushed_to_gallery_at
           FROM photo_library
           WHERE ${where}
           ORDER BY filename ASC`
        ).bind(...params).all();

        return json({ photos: rows.results || [] }, 200, origin);
      }

      // ── GET /api/library/file/:id ────────────────────────────────
      if (url.pathname.startsWith('/api/library/file/') && request.method === 'GET') {
        const id = parseInt(url.pathname.split('/').pop(), 10);
        if (!id) return json({ error: 'Invalid id' }, 400, origin);

        const row = await env.DB.prepare(
          `SELECT r2_key, thumb_r2_key, mime_type, linked_teams FROM photo_library WHERE id = ?`
        ).bind(id).first();
        if (!row) return json({ error: 'Not found' }, 404, origin);

        if (caller.role !== 'admin' && row.linked_teams) {
          const linkedTeams = JSON.parse(row.linked_teams);
          const overlap = linkedTeams.some(t => caller.teams.includes(t));
          if (!overlap) return json({ error: 'Forbidden' }, 403, origin);
        }

        const key = url.searchParams.get('thumb') === '1' ? row.thumb_r2_key : row.r2_key;
        const obj = await env.LIBRARY.get(key);
        if (!obj) return json({ error: 'R2 object missing' }, 404, origin);

        return new Response(obj.body, {
          headers: {
            'Content-Type': row.mime_type,
            'Cache-Control': 'private, max-age=300',
            'ETag': obj.httpEtag,
            ...corsHeaders(origin),
          },
        });
      }

      // ── POST /api/library/upload ──────────────────────────────────
      if (url.pathname === '/api/library/upload' && request.method === 'POST') {
        if (caller.role !== 'admin') return json({ error: 'Admin only' }, 403, origin);
        return handleUpload(request, env, caller, origin);
      }

      // ── POST /api/library/:id/assign-player ──────────────────────
      if (url.pathname.match(/^\/api\/library\/\d+\/assign-player$/) && request.method === 'POST') {
        const id   = parseInt(url.pathname.split('/')[3], 10);
        const body = await request.json();
        const playerId = parseInt(body.player_id, 10);
        if (!playerId) return json({ error: 'player_id required' }, 400, origin);

        const player = await env.DB.prepare(
          `SELECT id, team_category FROM players WHERE id = ?`
        ).bind(playerId).first();
        if (!player) return json({ error: 'Player not found' }, 404, origin);

        if (caller.role !== 'admin' && !caller.teams.includes(player.team_category)) {
          return json({ error: 'Forbidden: not your team' }, 403, origin);
        }

        const photo = await env.DB.prepare(
          `SELECT id, r2_key, mime_type, linked_teams, linked_player_ids FROM photo_library WHERE id = ?`
        ).bind(id).first();
        if (!photo) return json({ error: 'Photo not found' }, 404, origin);

        const srcObj = await env.LIBRARY.get(photo.r2_key);
        if (!srcObj) return json({ error: 'Library R2 object missing' }, 500, origin);

        // Flat key — roster worker's /api/photos/:filename uses .pop() so subdirectory keys fail.
        // Public URL format matches existing players.photo_url: /api/photos/<filename>
        const ext       = photo.mime_type === 'image/png' ? 'png' : photo.mime_type === 'image/webp' ? 'webp' : 'jpg';
        const publicKey = `player_${playerId}.${ext}`;
        await env.GALLERY.put(publicKey, srcObj.body, {
          httpMetadata: { contentType: photo.mime_type },
        });
        const publicUrl = `/api/photos/${publicKey}`;

        // E1c: multi-team stamp — append player's team if not already present
        const teams     = photo.linked_teams     ? JSON.parse(photo.linked_teams)     : [];
        const playerIds = photo.linked_player_ids ? JSON.parse(photo.linked_player_ids) : [];
        if (!teams.includes(player.team_category)) teams.push(player.team_category);
        if (!playerIds.includes(playerId)) playerIds.push(playerId);

        const now = new Date().toISOString();

        await env.DB.batch([
          env.DB.prepare(
            `UPDATE photo_library
             SET linked_teams = ?, linked_player_ids = ?,
                 first_linked_at = COALESCE(first_linked_at, ?), last_linked_at = ?
             WHERE id = ?`
          ).bind(JSON.stringify(teams), JSON.stringify(playerIds), now, now, photo.id),
          env.DB.prepare(
            `UPDATE players SET photo_url = ? WHERE id = ?`
          ).bind(publicUrl, playerId),
        ]);

        return json({ ok: true, photo_url: publicUrl }, 200, origin);
      }

      // ── POST /api/library/:id/push-to-gallery ────────────────────
      // Uploads original bytes to CF Images, then inserts into the `photos` table.
      // (photos table uses cf_image_id + team_category — verified in pre-flight)
      if (url.pathname.match(/^\/api\/library\/\d+\/push-to-gallery$/) && request.method === 'POST') {
        if (caller.role !== 'admin') return json({ error: 'Admin only' }, 403, origin);
        const id   = parseInt(url.pathname.split('/')[3], 10);
        const body = await request.json();
        const team      = body.team;
        const eventDate = body.event_date;
        const eventName = sanitizeText(body.event_name_fr, 100);
        const eventType = body.event_type && VALID_EVENT_TYPES.has(body.event_type)
          ? body.event_type
          : 'team_event';

        if (!ALLOWED_TEAMS.has(team)) return json({ error: 'Invalid team' }, 400, origin);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return json({ error: 'Invalid date' }, 400, origin);
        if (!eventName) return json({ error: 'event_name_fr required' }, 400, origin);
        if (caller.role !== 'admin' && !caller.teams.includes(team)) {
          return json({ error: 'Forbidden' }, 403, origin);
        }

        const photo = await env.DB.prepare(
          `SELECT r2_key, mime_type FROM photo_library WHERE id = ?`
        ).bind(id).first();
        if (!photo) return json({ error: 'Not found' }, 404, origin);

        const srcObj = await env.LIBRARY.get(photo.r2_key);
        if (!srcObj) return json({ error: 'R2 source missing' }, 404, origin);

        // Upload to CF Images so the public gallery can render it
        const imgForm = new FormData();
        const blob    = new Blob([await srcObj.arrayBuffer()], { type: photo.mime_type });
        imgForm.append('file', blob, `library_${id}.jpg`);

        const cfBase = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/images/v1`;
        const cfRes  = await fetch(cfBase, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.CF_IMAGES_TOKEN}` },
          body: imgForm,
        });
        const cfData = await cfRes.json();
        if (!cfData.success) {
          console.error('[push-to-gallery] CF Images upload failed:', JSON.stringify(cfData.errors));
          return json({ error: 'CF Images upload failed' }, 502, origin);
        }
        const cfImageId = cfData.result.id;

        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO photos (cf_image_id, team_category, event_type, event_name_fr, event_date, uploaded_by)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(cfImageId, team, eventType, eventName, eventDate, caller.email),
          env.DB.prepare(
            `UPDATE photo_library SET pushed_to_gallery_at = CURRENT_TIMESTAMP, pushed_to_gallery_by = ?
             WHERE id = ?`
          ).bind(caller.email, id),
        ]);

        return json({ ok: true }, 200, origin);
      }

      // ── DELETE /api/library/:id ───────────────────────────────────
      if (url.pathname.match(/^\/api\/library\/\d+$/) && request.method === 'DELETE') {
        if (caller.role !== 'admin') return json({ error: 'Admin only' }, 403, origin);

        const id  = parseInt(url.pathname.split('/').pop(), 10);
        const row = await env.DB.prepare(
          `SELECT r2_key, thumb_r2_key FROM photo_library WHERE id = ?`
        ).bind(id).first();
        if (!row) return json({ error: 'Not found' }, 404, origin);

        await env.LIBRARY.delete(row.r2_key);
        await env.LIBRARY.delete(row.thumb_r2_key);
        await env.DB.prepare(`DELETE FROM photo_library WHERE id = ?`).bind(id).run();

        return json({ ok: true }, 200, origin);
      }

      return json({ error: 'Not found' }, 404, origin);

    } catch (e) {
      console.error('[library-worker]', e);
      return json({ error: e.message }, 500, origin);
    }
  },
};
