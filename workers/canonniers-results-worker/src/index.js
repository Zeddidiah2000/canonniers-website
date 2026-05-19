const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const STATUSES = ['final', 'forfeit', 'cancelled', 'postponed'];
const TEAMS = ['u15', 'u17d1', 'u17d2'];
const KEY = 'all';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function validate(r) {
  const id = Number(r.spordle_game_id);
  if (!Number.isInteger(id) || id <= 0) return 'spordle_game_id must be positive integer';
  if (!TEAMS.includes(r.team_category)) return 'team_category invalid';
  if (!r.game_date || isNaN(new Date(r.game_date))) return 'game_date invalid';
  if (!STATUSES.includes(r.status)) return 'status invalid';
  const h = Number(r.home_score), a = Number(r.away_score);
  if (!Number.isInteger(h) || h < 0 || h > 99) return 'home_score 0-99';
  if (!Number.isInteger(a) || a < 0 || a > 99) return 'away_score 0-99';
  if (r.game_number && String(r.game_number).length > 32) return 'game_number too long';
  if (r.notes && String(r.notes).length > 500) return 'notes too long';
  return null;
}

function clean(r) {
  return {
    spordle_game_id: Number(r.spordle_game_id),
    team_category: r.team_category,
    game_date: r.game_date,
    game_number: r.game_number ? String(r.game_number).slice(0, 32) : null,
    home_score: Number(r.home_score),
    away_score: Number(r.away_score),
    status: r.status,
    notes: r.notes ? String(r.notes).trim().slice(0, 500) : null,
    updated_at: new Date().toISOString(),
  };
}

async function loadAll(env) {
  const raw = await env.RESULTS.get(KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function saveAll(env, arr) {
  await env.RESULTS.put(KEY, JSON.stringify(arr));
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    // GET /api/results — public
    if (request.method === 'GET' && path === '/api/results') {
      const results = await loadAll(env);
      return new Response(JSON.stringify(results), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          ...CORS,
        },
      });
    }

    // Authed routes below
    const auth = request.headers.get('Authorization') || '';
    if (auth !== `Bearer ${env.RESULTS_TOKEN}`) {
      return json({ error: 'Unauthorized' }, 401);
    }

    // PUT /api/results/:id
    const putMatch = path.match(/^\/api\/results\/(\d+)$/);
    if (request.method === 'PUT' && putMatch) {
      const id = Number(putMatch[1]);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      body.spordle_game_id = id;
      const err = validate(body);
      if (err) return json({ error: err }, 400);
      const all = await loadAll(env);
      const idx = all.findIndex(r => r.spordle_game_id === id);
      const row = clean(body);
      if (idx >= 0) all[idx] = row; else all.push(row);
      await saveAll(env, all);
      return json(row);
    }

    // DELETE /api/results/:id
    if (request.method === 'DELETE' && putMatch) {
      const id = Number(putMatch[1]);
      const all = await loadAll(env);
      const next = all.filter(r => r.spordle_game_id !== id);
      if (next.length === all.length) return json({ error: 'Not found' }, 404);
      await saveAll(env, next);
      return json({ deleted: id });
    }

    return json({ error: 'Not found' }, 404);
  },
};
