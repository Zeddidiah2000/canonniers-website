const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const VALID_BT  = new Set(['R/R','R/L','L/L','L/R','S/R','S/L','']);
const VALID_POS = new Set(['P','C','1B','2B','3B','SS','LF','CF','RF','OF','IF','DH']);

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

      // GET /api/photos/:filename - MUST BE PUBLIC
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

        const { name, number, position, bats_throws, height, weight, photo_url, team_category, stats_json, birthdate, hometown, height_inches } = data;
        await env.DB.prepare(
          'UPDATE players SET name=?, number=?, position=?, bats_throws=?, height=?, weight=?, photo_url=?, team_category=?, stats_json=?, birthdate=?, hometown=?, height_inches=? WHERE id=?'
        ).bind(name || null, number || null, position || null, bats_throws || null, height || null, weight || null, photo_url || null, team_category || null, stats_json || null, birthdate || null, hometown || null, height_inches ?? null, id).run();
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

      return new Response('Not Found', { status: 404, headers: corsHeaders });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message, stack: e.stack }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
};
