/**
 * GET /list?game_id=X[&published=1]
 *
 * Returns cards for a specific game.
 * Public (published=1) callers get only published, non-archived cards.
 * Authenticated admin/coach callers get all cards (including unpublished) for their accessible teams.
 */

import { jsonResponse, errorResponse } from '../http';
import type { Env, AuthContext } from '../types';

export async function handleList(request: Request, env: Env, authContext: AuthContext): Promise<Response> {
  const url = new URL(request.url);
  const gameId = url.searchParams.get('game_id');
  const publishedOnly = url.searchParams.get('published') === '1';

  if (!gameId) {
    return errorResponse(400, 'game_id required', env);
  }

  // Validate game_id is alphanumeric to prevent injection in indexed lookup
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(gameId)) {
    return errorResponse(400, 'Invalid game_id format', env);
  }

  let query: string;
  let bindings: string[];

  if (publishedOnly) {
    // Public-facing query: only published, non-archived
    query = `
      SELECT id, game_id, team_id, template, lang, size_variant, r2_key,
             published_at, created_at, metadata
      FROM generated_cards
      WHERE game_id = ?
        AND published = 1
        AND archived = 0
        AND deleted_at IS NULL
      ORDER BY created_at DESC
    `;
    bindings = [gameId];
  } else {
    // Admin/coach view: all non-deleted, scoped to accessible teams
    if (!authContext.isAdmin) {
      // Coach: filter to their team only
      const team = authContext.teams[0];
      if (!team) return errorResponse(403, 'No team scope', env);
      query = `
        SELECT id, game_id, team_id, template, lang, size_variant, r2_key,
               published, published_at, archived, created_by, created_at, metadata
        FROM generated_cards
        WHERE game_id = ?
          AND team_id = ?
          AND deleted_at IS NULL
        ORDER BY created_at DESC
      `;
      bindings = [gameId, team];
    } else {
      // Admin: all teams
      query = `
        SELECT id, game_id, team_id, template, lang, size_variant, r2_key,
               published, published_at, archived, created_by, created_at, metadata
        FROM generated_cards
        WHERE game_id = ?
          AND deleted_at IS NULL
        ORDER BY created_at DESC
      `;
      bindings = [gameId];
    }
  }

  const result = await env.DB.prepare(query).bind(...bindings).all<Record<string, unknown>>();

  // Transform r2_key to full URL for client convenience
  const cards = result.results.map((row) => ({
    ...row,
    url: `https://cards.canonniersdequebec.ca/${row.r2_key}`,
  }));

  return jsonResponse({ game_id: gameId, count: cards.length, cards }, env);
}
