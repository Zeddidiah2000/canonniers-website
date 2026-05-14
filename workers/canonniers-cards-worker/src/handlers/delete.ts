/**
 * POST /delete
 * Body: { id: number }
 *
 * Soft-deletes a card. Owner-of-card OR admin (D07 commit 7 — was admin-only).
 * Sets deleted_at timestamp; row remains in DB for audit.
 * Does NOT remove the R2 object (deferred to a future cleanup job).
 */

import { jsonResponse, errorResponse } from '../http';
import type { Env, AuthContext } from '../types';

export async function handleDelete(request: Request, env: Env, authContext: AuthContext): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON', env);
  }

  const id = parseInt((body as { id: unknown }).id as string, 10);
  if (!Number.isInteger(id) || id < 1) {
    return errorResponse(400, 'Invalid id', env);
  }

  // Owner-or-admin check before soft-deleting
  const card = await env.DB.prepare(
    `SELECT created_by, deleted_at FROM generated_cards WHERE id = ?`
  ).bind(id).first<{ created_by: string; deleted_at: number | null }>();
  if (!card) return errorResponse(404, 'Card not found', env);
  if (card.deleted_at) return errorResponse(404, 'Card already deleted', env);
  if (!authContext.isAdmin && card.created_by !== authContext.email) {
    return errorResponse(403, 'Forbidden — not card owner', env);
  }

  const result = await env.DB.prepare(`
    UPDATE generated_cards
    SET deleted_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `).bind(Math.floor(Date.now() / 1000), id).run();

  if (result.meta.changes === 0) {
    return errorResponse(404, 'Card not found or already deleted', env);
  }

  return jsonResponse({ deleted: true, id }, env);
}
