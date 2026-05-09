/**
 * POST /delete
 * Body: { id: number }
 *
 * Soft-deletes a card. Admin only.
 * Sets deleted_at timestamp; row remains in DB for audit.
 * Does NOT remove the R2 object (deferred to a future cleanup job).
 */

import { jsonResponse, errorResponse } from '../http.js';

export async function handleDelete(request, env, authContext) {
  if (!authContext.isAdmin) {
    return errorResponse(403, 'Admin only', env);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON', env);
  }

  const id = parseInt(body.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return errorResponse(400, 'Invalid id', env);
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
