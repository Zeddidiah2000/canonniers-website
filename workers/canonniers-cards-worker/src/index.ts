/**
 * canonniers-cards-worker
 *
 * Foundation Worker for the card generator system.
 * Per ADR-001 v2 (2026-05-09) and Directive 01 v2 / Directive 02 v1.
 *
 * Auth pattern matches admin-photos.html reference implementation:
 *   1. Verify CF Access JWT (cf-access-jwt-assertion header)
 *   2. Extract email from verified JWT
 *   3. Call auth-worker?email=X to resolve {role, teams}
 *
 * Endpoints:
 *   GET  /health           - liveness check (no auth)
 *   GET  /preview          - placeholder, returns 501
 *   POST /render           - render a game-day card via Browser Rendering
 *   GET  /list?game_id=X   - returns cards for a game
 *   POST /delete           - soft delete (admin only)
 *   GET  /photos           - placeholder, returns 501
 */

import { verifyAccessJwt } from './auth';
import { resolveRole } from './role';
import { jsonResponse, errorResponse, corsHeaders } from './http';
import { handleList } from './handlers/list';
import { handleListMine, handleListAll } from './handlers/list-user';
import { handleDelete } from './handlers/delete';
import { handleRender } from './render';
import type { Env } from './types';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    // Health check (no auth)
    if (url.pathname === '/health' && request.method === 'GET') {
      return jsonResponse({ status: 'ok', version: 'directive-02-v1' }, env);
    }

    // All other endpoints require CF Access JWT
    let identity;
    try {
      identity = await verifyAccessJwt(request, env);
    } catch {
      return errorResponse(401, 'Unauthorized', env);
    }

    // Resolve role + teams via auth-worker
    let authContext;
    try {
      authContext = await resolveRole(identity.email, env);
    } catch {
      return errorResponse(403, 'Role resolution failed', env);
    }

    // Route
    try {
      if (url.pathname === '/preview' && request.method === 'GET') {
        return errorResponse(501, 'Not implemented', env);
      }
      if (url.pathname === '/render' && request.method === 'POST') {
        return handleRender(request, env, authContext);
      }
      if (url.pathname === '/photos' && request.method === 'GET') {
        return errorResponse(501, 'Not implemented', env);
      }
      if (url.pathname === '/list/mine' && request.method === 'GET') {
        return handleListMine(request, env, authContext);
      }
      if (url.pathname === '/list/all' && request.method === 'GET') {
        return handleListAll(request, env, authContext);
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
  },
} satisfies ExportedHandler<Env>;
