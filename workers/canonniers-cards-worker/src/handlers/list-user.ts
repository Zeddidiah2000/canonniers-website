/**
 * GET /list/mine — caller's own cards (created_by = caller email, not deleted)
 * GET /list/all  — admin-only; if caller role ≠ admin, silently degrades to /list/mine
 *
 * Response shape consumed by admin-social.html "Mes cartes" grid:
 *   { count, cards: [{ id, template, team_id, size_variant, r2_key, url,
 *                      created_by, created_at, metadata }, ...] }
 *
 * Directive #7, commit 7. Handoff override #1: separate endpoints, not ?scope=.
 */

import { jsonResponse } from '../http';
import type { Env, AuthContext } from '../types';

const COLUMNS = `id, template, team_id, size_variant, r2_key,
                 created_by, created_at, metadata`;

function shapeRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    template: row.template,
    team_id: row.team_id,
    size_variant: row.size_variant,
    r2_key: row.r2_key,
    created_by: row.created_by,
    created_at: row.created_at,
    metadata: row.metadata,
    url: `https://cards.canonniersdequebec.ca/${row.r2_key}`,
  };
}

export async function handleListMine(_request: Request, env: Env, authContext: AuthContext): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT ${COLUMNS}
     FROM generated_cards
     WHERE created_by = ? AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT 50`
  ).bind(authContext.email).all<Record<string, unknown>>();

  const cards = (result.results || []).map(shapeRow);
  return jsonResponse({ count: cards.length, cards }, env);
}

export async function handleListAll(request: Request, env: Env, authContext: AuthContext): Promise<Response> {
  // Silently degrade to /list/mine for non-admin callers — directive intent
  if (!authContext.isAdmin) {
    return handleListMine(request, env, authContext);
  }
  const result = await env.DB.prepare(
    `SELECT ${COLUMNS}
     FROM generated_cards
     WHERE deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT 50`
  ).all<Record<string, unknown>>();

  const cards = (result.results || []).map(shapeRow);
  return jsonResponse({ count: cards.length, cards }, env);
}
