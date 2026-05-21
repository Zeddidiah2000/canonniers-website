// canonniers-news-worker — proxies Spordle league news for canonniersdequebec.ca
//
// Endpoint: GET /api/news?lang=fr&limit=5
// Returns { items: [{ id, title, date, href }] }
//
// Auth: x-api-key is stored as the SPORDLE_PAGE_API_KEY secret (set via
// `printf "%s" "<key>" | wrangler secret put SPORDLE_PAGE_API_KEY` — printf,
// not echo, or the trailing \n silently breaks the header).
//
// Caching: 10-min edge cache via caches.default.

const PAGE_ID     = '1ede2a36-2bb4-6d6a-939c-0694486dd694'; // ligue-du-reseau-de-developpement-aaa
const LEAGUE_SLUG = 'ligue-du-reseau-de-developpement-aaa';
const SPORDLE_API = 'https://api.page.spordle.com';
const CACHE_TTL   = 600;  // 10 min
const MAX_ITEMS   = 5;

function corsHeaders(origin) {
  const allowed = [
    'https://canonniersdequebec.ca',
    'https://www.canonniersdequebec.ca',
    'https://canonniers-website.pages.dev',
  ];
  const allow = allowed.includes(origin) ? origin : 'https://canonniersdequebec.ca';
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age':       '86400',
  };
}

function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (url.pathname !== '/api/news') {
      return json({ error: 'Not found' }, 404, corsHeaders(origin));
    }

    const lang  = (url.searchParams.get('lang') || 'fr').toLowerCase();
    const limit = Math.min(parseInt(url.searchParams.get('limit') || MAX_ITEMS, 10) || MAX_ITEMS, 20);

    const cacheKey = new Request(`https://news-cache/news?lang=${lang}&limit=${limit}`);
    const cache    = caches.default;
    const cached   = await cache.match(cacheKey);
    if (cached) return cached;

    const apiUrl = `${SPORDLE_API}/pages/${PAGE_ID}/custom-pages?display_lang=${lang}&type=NEWS`;
    let upstream;
    try {
      upstream = await fetch(apiUrl, {
        headers: {
          'Accept':    'application/json, text/plain, */*',
          'Origin':    'https://page.spordle.com',
          'Referer':   'https://page.spordle.com/',
          'x-api-key': env.SPORDLE_PAGE_API_KEY,
        },
      });
    } catch (err) {
      return json({ error: 'upstream fetch failed', detail: err.message }, 502, corsHeaders(origin));
    }
    if (!upstream.ok) {
      return json({ error: 'upstream error', status: upstream.status }, 502, corsHeaders(origin));
    }

    const data  = await upstream.json();
    const items = (data.custom_pages || [])
      .filter(p => String(p.is_published) === '1')
      .sort((a, b) => new Date(b.published_date) - new Date(a.published_date))
      .slice(0, limit)
      .map(p => ({
        id:    p.custom_page_id,
        title: p.i18n?.[lang]?.name || p.name,
        date:  p.published_date,
        href:  `https://page.spordle.com/${lang}/${LEAGUE_SLUG}/news/${p.custom_page_id}`,
      }));

    const response = json({ items }, 200, {
      ...corsHeaders(origin),
      'Cache-Control': `public, max-age=${CACHE_TTL}`,
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};
