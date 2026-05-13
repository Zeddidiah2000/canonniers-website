const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const VALID_BT  = new Set(['R/R','R/L','L/L','L/R','S/R','S/L','']);
const VALID_POS = new Set(['P','C','1B','2B','3B','SS','LF','CF','RF','OF','IF','DH']);

const ALLOWED_COACH_MIME    = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_COACH_PHOTO_BYTES = 5 * 1024 * 1024;
const VALID_COACH_SLUGS     = new Set([
  'dave-dufour','mathieu-fontaine','jean-christophe-masson','vincent-leveille',
  'jonathan-landry','jean-pierre-chamberland','mathieu-vachon','loic-masse',
  'mathieu-deschenes','arthur-perrois','laurent-savard','francis-verge',
]);

const VALID_COACH_TEAMS = new Set(['u15', 'u17d1', 'u17d2']);

function safeParseJsonArray(s) {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function validatePlayer(data) {
  const { bats_throws, position, weight, birthdate, height_inches } = data;

  if (bats_throws != null && bats_throws !== '' && !VALID_BT.has(bats_throws)) {
    return `Invalid bats_throws: ${bats_throws}`;
  }

  if (position != null && position !== '') {
    for (const code of position.split(',')) {
      if (!VALID_POS.has(code.trim())) return `Invalid position code: ${code}`;
    }
  }

  if (weight != null && weight !== '') {
    const w = parseInt(weight);
    if (isNaN(w) || w < 80 || w > 250) return 'Weight must be 80–250 lbs';
  }

  if (birthdate != null && birthdate !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) return 'Invalid birthdate (YYYY-MM-DD)';
  }

  if (height_inches != null && height_inches !== '') {
    const h = Number(height_inches);
    if (!Number.isInteger(h) || h < 48 || h > 96) return 'Invalid height_inches';
  }

  return null;
}

// Validate a coach payload for PUT. Returns error string or null.
// Partial-update semantics — only validates fields that are present.
function validateCoach(data) {
  if (typeof data !== 'object' || data === null) return 'Invalid payload';

  if ('name' in data) {
    if (typeof data.name !== 'string' || data.name.trim().length === 0) return 'name must be non-empty string';
    if (data.name.length > 100) return 'name too long (max 100)';
  }
  if ('number' in data && data.number !== null && data.number !== '') {
    if (typeof data.number !== 'string' || !/^\d{1,3}$/.test(data.number)) return 'number must be 1-3 digit string';
  }
  if ('role_fr' in data) {
    if (typeof data.role_fr !== 'string' || data.role_fr.length > 60) return 'role_fr invalid (max 60 chars)';
  }
  if ('role_en' in data) {
    if (typeof data.role_en !== 'string' || data.role_en.length > 60) return 'role_en invalid (max 60 chars)';
  }
  if ('team' in data) {
    if (!VALID_COACH_TEAMS.has(data.team)) return 'team must be u15, u17d1, or u17d2';
  }
  if ('coaching_since' in data && data.coaching_since !== null && data.coaching_since !== '') {
    if (!/^(19|20)\d{2}$/.test(String(data.coaching_since))) return 'coaching_since must be a 4-digit year (1900-2099)';
  }
  if ('with_org_since' in data && data.with_org_since !== null && data.with_org_since !== '') {
    if (!/^(19|20)\d{2}$/.test(String(data.with_org_since))) return 'with_org_since must be a 4-digit year (1900-2099)';
  }
  if ('bio_fr' in data) {
    if (typeof data.bio_fr !== 'string') return 'bio_fr must be string';
    if (data.bio_fr.length > 5000) return 'bio_fr too long (max 5000 chars)';
  }
  if ('bio_en' in data) {
    if (typeof data.bio_en !== 'string') return 'bio_en must be string';
    if (data.bio_en.length > 5000) return 'bio_en too long (max 5000 chars)';
  }
  if ('playing_bg' in data) {
    if (!Array.isArray(data.playing_bg)) return 'playing_bg must be array';
    if (data.playing_bg.length > 20) return 'playing_bg too many entries (max 20)';
    for (const entry of data.playing_bg) {
      if (typeof entry !== 'object' || entry === null) return 'playing_bg entries must be objects';
      const allowedKeys = ['level_fr', 'level_en', 'where', 'years'];
      for (const k of Object.keys(entry)) {
        if (!allowedKeys.includes(k)) return `playing_bg entry has unknown key: ${k}`;
      }
      for (const k of allowedKeys) {
        if (k in entry && entry[k] !== null) {
          if (typeof entry[k] !== 'string') return `playing_bg.${k} must be string`;
          if (entry[k].length > 100) return `playing_bg.${k} too long (max 100 chars)`;
        }
      }
    }
  }

  return null;
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // ── PUBLIC ROUTES ──────────────────────────────────────────────

      // GET /api/players
      if (path === '/api/players' && request.method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM players ORDER BY team_category, name').all();
        return new Response(JSON.stringify(results), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // MUST BE PUBLIC — player and coach headshots are displayed on public pages
      if (path.startsWith('/api/photos/')) {
        const filename = path.split('/').pop();
        const object = await env.BUCKET.get(filename);
        if (!object) return new Response('Not found', { status: 404, headers: corsHeaders });

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('etag', object.httpEtag);

        return new Response(object.body, { headers });
      }

      // GET /api/coach-photos — PUBLIC, returns { slug: photo_url } map
      if (path === '/api/coach-photos' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT slug, photo_url FROM coach_photos'
        ).all();
        const map = {};
        for (const row of results) map[row.slug] = row.photo_url;
        return new Response(JSON.stringify(map), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // GET /api/coaches — PUBLIC, list all coaches (playing_bg parsed to array)
      if (path === '/api/coaches' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT slug, name, number, role_fr, role_en, team, coaching_since, with_org_since, bio_fr, bio_en, playing_bg FROM coaches ORDER BY team, name'
        ).all();
        const coaches = (results || []).map(c => ({
          ...c,
          playing_bg: safeParseJsonArray(c.playing_bg),
        }));
        return new Response(JSON.stringify(coaches), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // GET /api/coaches/:slug — PUBLIC, single coach (404 on missing)
      if (path.startsWith('/api/coaches/') && request.method === 'GET') {
        const slug = decodeURIComponent(path.split('/').pop() || '');
        if (!/^[a-z0-9-]{1,60}$/.test(slug)) {
          return new Response(JSON.stringify({ error: 'Invalid slug' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        const row = await env.DB.prepare(
          'SELECT slug, name, number, role_fr, role_en, team, coaching_since, with_org_since, bio_fr, bio_en, playing_bg FROM coaches WHERE slug = ?'
        ).bind(slug).first();
        if (!row) {
          return new Response(JSON.stringify({ error: 'Not found' }), {
            status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        row.playing_bg = safeParseJsonArray(row.playing_bg);
        return new Response(JSON.stringify(row), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // ── PROTECTED ROUTES ───────────────────────────────────────────
      const authHeader = request.headers.get('Authorization');
      if (authHeader !== 'Bearer canonniers2026') {
        return new Response('Unauthorized', { status: 401, headers: corsHeaders });
      }

      if (path === '/api/players' && request.method === 'POST') {
        const data = await request.json();
        const err = validatePlayer(data);
        if (err) return new Response(JSON.stringify({ error: err }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });

        const { name, number, position, bats_throws, height, weight, photo_url, team_category, stats_json, birthdate, hometown, height_inches } = data;
        await env.DB.prepare(
          'INSERT INTO players (name, number, position, bats_throws, height, weight, photo_url, team_category, stats_json, birthdate, hometown, height_inches) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(name || null, number || null, position || null, bats_throws || null, height || null, weight || null, photo_url || null, team_category || null, stats_json || null, birthdate || null, hometown || null, height_inches ?? null).run();
        return new Response('OK', { headers: corsHeaders });
      }

      if (path.startsWith('/api/players/') && request.method === 'PUT') {
        const id = path.split('/').pop();
        const data = await request.json();
        const err = validatePlayer(data);
        if (err) return new Response(JSON.stringify({ error: err }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });

        // Partial update: only update fields the client actually sent.
        // Empty string -> NULL (clears the field). Missing key -> column untouched.
        const allowed = [
          'name', 'number', 'position', 'bats_throws', 'height', 'weight',
          'photo_url', 'team_category', 'stats_json', 'birthdate', 'hometown',
          'height_inches'
        ];

        const fields = [];
        const values = [];
        for (const key of allowed) {
          if (key in data) {
            fields.push(`${key}=?`);
            const v = data[key];
            values.push(v === '' ? null : v);
          }
        }

        if (fields.length === 0) {
          return new Response(JSON.stringify({ error: 'No fields to update' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        values.push(id);
        await env.DB.prepare(
          `UPDATE players SET ${fields.join(', ')} WHERE id=?`
        ).bind(...values).run();

        return new Response('OK', { headers: corsHeaders });
      }

      if (path.startsWith('/api/players/') && request.method === 'DELETE') {
        const id = path.split('/').pop();
        await env.DB.prepare('DELETE FROM players WHERE id=?').bind(id).run();
        return new Response('OK', { headers: corsHeaders });
      }

      // POST /api/upload
      if (path === '/api/upload' && request.method === 'POST') {
        const formData = await request.formData();
        const file = formData.get('file');
        if (!file) return new Response('No file', { status: 400, headers: corsHeaders });

        const filename = `${Date.now()}-${file.name}`;
        await env.BUCKET.put(filename, file.stream(), {
          httpMetadata: { contentType: file.type }
        });

        return new Response(JSON.stringify({ url: `/api/photos/${filename}` }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // POST /api/coach-photos — PROTECTED, upsert coach headshot
      if (path === '/api/coach-photos' && request.method === 'POST') {
        const formData = await request.formData();
        const file = formData.get('file');
        const slug = (formData.get('slug') || '').trim();

        if (!slug || !VALID_COACH_SLUGS.has(slug)) {
          return new Response(JSON.stringify({ error: 'Invalid slug' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        if (!file) {
          return new Response(JSON.stringify({ error: 'No file' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        if (!ALLOWED_COACH_MIME.has(file.type)) {
          return new Response(JSON.stringify({ error: 'Type non valide. Acceptés : JPEG, PNG, WEBP.' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        if (file.size > MAX_COACH_PHOTO_BYTES) {
          return new Response(JSON.stringify({ error: 'Fichier trop volumineux. Max 5 Mo.' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // Read existing r2_key and delete old object (fail-open)
        const existing = await env.DB.prepare(
          'SELECT r2_key FROM coach_photos WHERE slug = ?'
        ).bind(slug).first();
        if (existing?.r2_key) {
          try {
            await env.BUCKET.delete(existing.r2_key);
          } catch (e) {
            console.error(`coach R2 delete failed slug=${slug} key=${existing.r2_key}: ${e.message}`);
          }
        }

        const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
        const r2Key = `coach-${slug}-${Date.now()}.${ext}`;
        await env.BUCKET.put(r2Key, file.stream(), {
          httpMetadata: { contentType: file.type }
        });

        const photoUrl = `/api/photos/${r2Key}`;

        await env.DB.prepare(`
          INSERT INTO coach_photos (slug, photo_url, r2_key, created_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(slug) DO UPDATE SET
            photo_url  = excluded.photo_url,
            r2_key     = excluded.r2_key,
            created_at = excluded.created_at
        `).bind(slug, photoUrl, r2Key).run();

        return new Response(JSON.stringify({ url: photoUrl }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // PUT /api/coaches/:slug — PROTECTED, partial update with validation
      if (path.startsWith('/api/coaches/') && request.method === 'PUT') {
        const slug = decodeURIComponent(path.split('/').pop() || '');
        if (!/^[a-z0-9-]{1,60}$/.test(slug)) {
          return new Response(JSON.stringify({ error: 'Invalid slug' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const existing = await env.DB.prepare('SELECT slug FROM coaches WHERE slug = ?').bind(slug).first();
        if (!existing) {
          return new Response(JSON.stringify({ error: 'Coach not found' }), {
            status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        let data;
        try { data = await request.json(); }
        catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        }); }

        const err = validateCoach(data);
        if (err) return new Response(JSON.stringify({ error: err }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });

        // Partial update — same pattern as players PUT, but distinguish nullable vs non-nullable.
        // Empty string -> NULL only for nullable columns (number/coaching_since/with_org_since).
        // bio_fr/bio_en have NOT NULL DEFAULT '' — empty string stays as ''.
        // playing_bg is JSON-encoded array on write.
        const allowed = ['name', 'number', 'role_fr', 'role_en', 'team',
                         'coaching_since', 'with_org_since', 'bio_fr', 'bio_en', 'playing_bg'];
        const nullable = new Set(['number', 'coaching_since', 'with_org_since']);

        const setClauses = [];
        const values = [];

        for (const field of allowed) {
          if (!(field in data)) continue;
          let v = data[field];
          if (field === 'playing_bg') {
            v = JSON.stringify(v);
          } else if (typeof v === 'string') {
            v = v.trim();
            if (v === '' && nullable.has(field)) v = null;
          }
          setClauses.push(`${field} = ?`);
          values.push(v);
        }

        if (setClauses.length === 0) {
          return new Response(JSON.stringify({ error: 'No updatable fields provided' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        setClauses.push(`updated_at = datetime('now')`);
        values.push(slug);

        await env.DB.prepare(
          `UPDATE coaches SET ${setClauses.join(', ')} WHERE slug = ?`
        ).bind(...values).run();

        const updated = await env.DB.prepare(
          'SELECT slug, name, number, role_fr, role_en, team, coaching_since, with_org_since, bio_fr, bio_en, playing_bg, updated_at FROM coaches WHERE slug = ?'
        ).bind(slug).first();
        updated.playing_bg = safeParseJsonArray(updated.playing_bg);

        return new Response(JSON.stringify(updated), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message, stack: e.stack }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
};
