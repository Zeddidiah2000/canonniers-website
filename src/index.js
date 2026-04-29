const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // Basic Auth Check
      const authHeader = request.headers.get('Authorization');
      const isAuthorized = authHeader === 'Bearer canonniers2026';

      // GET /api/players
      if (path === '/api/players' && request.method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM players ORDER BY team_category, name').all();
        return new Response(JSON.stringify(results), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // Protected routes
      if (!isAuthorized) {
        return new Response('Unauthorized', { status: 401, headers: corsHeaders });
      }

      if (path === '/api/players' && request.method === 'POST') {
        const data = await request.json();
        const { name, number, position, bats_throws, height, weight, photo_url, team_category, stats_json } = data;
        await env.DB.prepare(
          'INSERT INTO players (name, number, position, bats_throws, height, weight, photo_url, team_category, stats_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(name || null, number || null, position || null, bats_throws || null, height || null, weight || null, photo_url || null, team_category || null, stats_json || null).run();
        return new Response('OK', { headers: corsHeaders });
      }

      if (path.startsWith('/api/players/') && request.method === 'PUT') {
        const id = path.split('/').pop();
        const data = await request.json();
        const { name, number, position, bats_throws, height, weight, photo_url, team_category, stats_json } = data;
        await env.DB.prepare(
          'UPDATE players SET name=?, number=?, position=?, bats_throws=?, height=?, weight=?, photo_url=?, team_category=?, stats_json=? WHERE id=?'
        ).bind(name || null, number || null, position || null, bats_throws || null, height || null, weight || null, photo_url || null, team_category || null, stats_json || null, id).run();
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

      // GET /api/photos/:filename
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

      return new Response('Not Found', { status: 404, headers: corsHeaders });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message, stack: e.stack }), { 
        status: 500, 
        headers: { 'Content-Type': 'application/json', ...corsHeaders } 
      });
    }
  }
};
