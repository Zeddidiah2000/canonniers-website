const ALL_TEAMS = ['u15', 'u17d1', 'u17d2'];

const TEAM_SUFFIX_MAP = {
  '15u':  'u15',
  '17d1': 'u17d1',
  '17d2': 'u17d2',
};

const ROLE_PATTERN = /^(coach|manager|social|photo|treasurer)(15u|17d1|17d2)@canonniers\.ca$/;

function resolveIdentity(emailRaw) {
  const email = String(emailRaw || '').toLowerCase().trim();

  if (email === 'jay@canonniers.ca') {
    return { role: 'admin', teams: ALL_TEAMS };
  }

  const m = email.match(ROLE_PATTERN);
  if (m) {
    const team = TEAM_SUFFIX_MAP[m[2]];
    if (team) return { role: m[1], teams: [team] };
  }

  return { role: 'unknown', teams: [] };
}

export default {
  async fetch(request, env) {
    const ALLOWED_ORIGINS = new Set([
      'https://canonniersdequebec.ca',
      'https://www.canonniersdequebec.ca',
    ]);

    const origin = request.headers.get('Origin');
    const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : 'https://canonniersdequebec.ca';

    const corsHeaders = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const email = (new URL(request.url).searchParams.get('email') || '').toLowerCase().trim();

    if (!email) {
      return new Response(JSON.stringify({ error: 'No email provided' }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const { role, teams } = resolveIdentity(email);

    return new Response(JSON.stringify({ email, role, teams }), {
      status: 200,
      headers: corsHeaders,
    });
  }
};
