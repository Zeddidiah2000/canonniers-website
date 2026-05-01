export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': 'https://canonniersdequebec.ca',
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

    let roleMap = {};
    try {
      roleMap = JSON.parse(env.ROLE_MAP);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'ROLE_MAP misconfigured' }), {
        status: 500,
        headers: corsHeaders,
      });
    }

    const role = roleMap[email] || 'unknown';

    return new Response(JSON.stringify({ email, role }), {
      status: 200,
      headers: corsHeaders,
    });
  }
};
