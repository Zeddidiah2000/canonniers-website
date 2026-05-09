/**
 * canonniers-cards-worker
 *
 * Foundation Worker for the card generator system.
 * Per ADR-001 v2 (2026-05-09) and Directive 01 v2.
 *
 * Auth pattern matches admin-photos.html reference implementation:
 *   1. Verify CF Access JWT (cf-access-jwt-assertion header)
 *   2. Extract email from verified JWT
 *   3. Call auth-worker?email=X to resolve {role, teams}
 *
 * Endpoints:
 *   GET  /health           - liveness check (no auth)
 *   GET  /preview          - placeholder, returns 501 in this directive
 *   POST /render           - placeholder, returns 501 in this directive
 *   GET  /list?game_id=X   - returns cards for a game
 *   POST /delete           - soft delete (admin only)
 *   GET  /photos           - placeholder, returns 501 in this directive
 *
 * Rate limiting: enforced at Cloudflare zone level (Rate Limiting Rules)
 */

import { verifyAccessJwt } from './auth.js';
import { resolveRole } from './role.js';
import { jsonResponse, errorResponse, corsHeaders } from './http.js';
import { handleList } from './handlers/list.js';
import { handleDelete } from './handlers/delete.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    // Health check (no auth)
    if (url.pathname === '/health' && request.method === 'GET') {
      return jsonResponse({ status: 'ok', version: 'directive-01-v2' }, env);
    }

    // All other endpoints require CF Access JWT
    let identity;
    try {
      identity = await verifyAccessJwt(request, env);
    } catch (err) {
      return errorResponse(401, 'Unauthorized', env);
    }

    // Resolve role + teams via auth-worker (no service token; plain query, matches admin-photos)
    let authContext;
    try {
      authContext = await resolveRole(identity.email, env);
    } catch (err) {
      return errorResponse(403, 'Role resolution failed', env);
    }

    // Route
    try {
      if (url.pathname === '/preview' && request.method === 'GET') {
        return errorResponse(501, 'Not implemented in directive 01', env);
      }
      if (url.pathname === '/render' && request.method === 'POST') {
        return errorResponse(501, 'Not implemented in directive 01', env);
      }
      if (url.pathname === '/photos' && request.method === 'GET') {
        return errorResponse(501, 'Not implemented in directive 01', env);
      }
      if (url.pathname === '/list' && request.method === 'GET') {
        return handleList(request, env, authContext);
      }
      if (url.pathname === '/delete' && request.method === 'POST') {
        return handleDelete(request, env, authContext);
      }
      return errorResponse(404, 'Not found', env);
    } catch (err) {
      console.error('Handler error:', err);
      return errorResponse(500, 'Internal server error', env);
    }
  }
};
