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

    const jwt = request.headers.get('Cf-Access-Jwt-Assertion');

    if (!jwt) {
      return new Response(JSON.stringify({ error: 'No Access JWT found' }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    let email = null;
    try {
      const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      email = (payload.email || '').toLowerCase().trim();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JWT payload' }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    if (!email) {
      return new Response(JSON.stringify({ error: 'No email in JWT' }), {
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
