/**
 * Shared HTTP helpers.
 */

export function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, cf-access-jwt-assertion',
    'Access-Control-Max-Age': '600'
  };
}

export function jsonResponse(data, env, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(env)
    }
  });
}

export function errorResponse(status, message, env) {
  return jsonResponse({ error: message }, env, status);
}
