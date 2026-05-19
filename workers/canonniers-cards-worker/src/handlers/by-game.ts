/**
 * GET /public/by-game?team_id=X&game_date=YYYY-MM-DD
 *
 * Public read-only endpoint (no JWT). Returns the best card image URL for the
 * given team + game date, intended as a thumbnail for the diffusion replay
 * grid.
 *
 * Why metadata-based matching: cards rendered to date have game_id = NULL in
 * the schema. We match via team_id (column) + game_date (json_extract from
 * metadata.payload.content.game_date).
 *
 * Template preference for "the card of the game that passed":
 *   result (post-game w/ final score) > game-day-v2 > game-day > blueprint > hype
 * Within a template tier, the most recently created card wins.
 *
 * CORS is locked to ALLOWED_ORIGIN via the shared corsHeaders helper.
 */

import { jsonResponse, errorResponse } from '../http';
import type { Env } from '../types';

const TEMPLATE_PRIORITY = ['result', 'game-day-v2', 'game-day', 'blueprint', 'hype'];
const VALID_TEAMS = new Set(['u15', 'u17d1', 'u17d2']);

interface CardRow {
  id: number;
  template: string;
  lang: string;
  r2_key: string;
  created_at: number;
}

export async function handlePublicByGame(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const teamId = url.searchParams.get('team_id');
  const gameDate = url.searchParams.get('game_date');

  if (!teamId || !VALID_TEAMS.has(teamId)) {
    return errorResponse(400, 'team_id must be u15, u17d1, or u17d2', env);
  }
  if (!gameDate || !/^\d{4}-\d{2}-\d{2}$/.test(gameDate)) {
    return errorResponse(400, 'game_date must be YYYY-MM-DD', env);
  }

  const result = await env.DB.prepare(`
    SELECT id, template, lang, r2_key, created_at
    FROM generated_cards
    WHERE team_id = ?
      AND json_extract(metadata, '$.payload.content.game_date') = ?
      AND deleted_at IS NULL
      AND archived = 0
    ORDER BY created_at DESC
  `).bind(teamId, gameDate).all<CardRow>();

  const rows = result.results || [];
  if (rows.length === 0) {
    return jsonResponse({ found: false }, env);
  }

  let chosen: CardRow | undefined;
  for (const tpl of TEMPLATE_PRIORITY) {
    chosen = rows.find((r) => r.template === tpl);
    if (chosen) break;
  }
  if (!chosen) chosen = rows[0];

  return jsonResponse({
    found: true,
    url: `https://cards.canonniersdequebec.ca/${chosen.r2_key}`,
    template: chosen.template,
    lang: chosen.lang,
    card_id: chosen.id,
  }, env);
}
