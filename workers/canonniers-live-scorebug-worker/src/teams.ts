/**
 * Opponent team lookup — queries spordle-proxy (via service binding) for a
 * team's schedule, harvests every distinct opposing team's name + logo from the
 * homeTeam/awayTeam objects, and returns a deduped sorted list.
 *
 * Cached in KV under `teams:{team}` with a 1h TTL.
 */

import type { Env } from './types';

interface Opponent {
  name: string;
  logo: string | null;
}

const TEAM_CACHE_TTL_SEC = 60 * 60;

function isCanonniers(name: string): boolean {
  return /canonniers/i.test(name || '');
}

export async function getOpponents(env: Env, team: string): Promise<Opponent[]> {
  const cacheKey = `teams:${team}`;
  const cached = await env.SCOREBUG.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached) as Opponent[]; } catch { /* fall through */ }
  }
  const list = await harvestFromSpordle(env, team);
  if (list.length) {
    await env.SCOREBUG.put(cacheKey, JSON.stringify(list), { expirationTtl: TEAM_CACHE_TTL_SEC });
  }
  return list;
}

// Spordle team id per team slot (office 4168). Env override wins; defaults match
// the CLAUDE.md team-id table.
function spordleTeamId(env: Env, team: string): string | null {
  const map: Record<string, string> = {
    u15:   env.SPORDLE_TEAM_ID_U15   || '156779',
    u17d1: env.SPORDLE_TEAM_ID_U17D1 || '156780',
    u17d2: env.SPORDLE_TEAM_ID_U17D2 || '156781',
  };
  return map[team] || null;
}

async function harvestFromSpordle(env: Env, team: string): Promise<Opponent[]> {
  const teamId = spordleTeamId(env, team);
  if (!teamId) return [];
  if (!env.SPORDLE_PROXY) return [];
  const officeId = env.SPORDLE_OFFICE_ID || '4168';

  const r = await env.SPORDLE_PROXY.fetch(
    `https://internal/?officeId=${officeId}&teamId=${teamId}`
  );
  if (!r.ok) return [];
  const games = await r.json().catch(() => []) as unknown;
  if (!Array.isArray(games)) return [];

  const byName = new Map<string, Opponent>();
  for (const g of games) {
    if (!g || typeof g !== 'object') continue;
    for (const side of ['homeTeam', 'awayTeam']) {
      const t = (g as Record<string, unknown>)[side];
      if (!t || typeof t !== 'object') continue;
      const obj = t as Record<string, unknown>;
      const name = typeof obj.name === 'string' ? obj.name.trim() : '';
      if (!name) continue;
      if (isCanonniers(name)) continue;
      const logo = (typeof obj.logo === 'string' && obj.logo)
        ? obj.logo
        : (typeof obj.logoUrl === 'string' && obj.logoUrl ? obj.logoUrl : null);
      if (!byName.has(name)) byName.set(name, { name, logo });
    }
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}
