import type { ScoreState } from './types';

const ALLOWED_TOP_KEYS = new Set([
  'visible', 'score', 'game', 'featured_player', 'overlay_scale'
]);

const ALLOWED_SCORE_KEYS = new Set([
  'home_name', 'away_name', 'home_logo_url', 'away_logo_url', 'home_runs', 'away_runs'
]);

const ALLOWED_GAME_KEYS = new Set([
  'inning', 'half', 'balls', 'strikes', 'outs', 'bases'
]);

const ALLOWED_PLAYER_KEYS = new Set([
  'number', 'mode', 'first_name', 'last_name', 'position',
  'bats', 'throws', 'photo_url', 'stats'
]);

function bad(msg: string): Error {
  const e = new Error(msg);
  (e as Error & { code?: number }).code = 400;
  return e;
}

function clampInt(v: unknown, min: number, max: number, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${field}: must be a number`);
  const n = Math.trunc(v);
  if (n < min || n > max) throw bad(`${field}: out of range [${min},${max}]`);
  return n;
}

function strOrEmpty(v: unknown, max: number, field: string): string {
  if (v == null) return '';
  if (typeof v !== 'string') throw bad(`${field}: must be a string`);
  if (v.length > max) throw bad(`${field}: max ${max} chars`);
  return v;
}

function strOrNull(v: unknown, max: number, field: string): string | null {
  if (v == null) return null;
  if (typeof v !== 'string') throw bad(`${field}: must be a string`);
  if (v.length > max) throw bad(`${field}: max ${max} chars`);
  return v;
}

function urlOrNull(v: unknown, field: string): string | null {
  if (v == null) return null;
  if (typeof v !== 'string') throw bad(`${field}: must be a string`);
  if (v.length > 500) throw bad(`${field}: max 500 chars`);
  if (!/^https?:\/\//.test(v)) throw bad(`${field}: must be http(s) URL`);
  return v;
}

export function validateState(raw: unknown): Omit<ScoreState, 'updated_at' | 'version'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw bad('Body must be a JSON object');
  }
  const r = raw as Record<string, unknown>;

  for (const k of Object.keys(r)) {
    if (!ALLOWED_TOP_KEYS.has(k)) throw bad(`Unknown key: ${k}`);
  }

  if (typeof r.visible !== 'boolean') throw bad('visible: must be boolean');

  if (!r.score || typeof r.score !== 'object') throw bad('score: required object');
  const s = r.score as Record<string, unknown>;
  for (const k of Object.keys(s)) {
    if (!ALLOWED_SCORE_KEYS.has(k)) throw bad(`score.${k}: unknown key`);
  }

  if (!r.game || typeof r.game !== 'object') throw bad('game: required object');
  const g = r.game as Record<string, unknown>;
  for (const k of Object.keys(g)) {
    if (!ALLOWED_GAME_KEYS.has(k)) throw bad(`game.${k}: unknown key`);
  }

  const half = g.half;
  if (half !== 'top' && half !== 'bottom') throw bad('game.half: must be "top" or "bottom"');

  const bases = (g.bases ?? {}) as Record<string, unknown>;
  if (typeof bases !== 'object') throw bad('game.bases: must be object');

  let featured: ScoreState['featured_player'] = null;
  if (r.featured_player != null) {
    if (typeof r.featured_player !== 'object') throw bad('featured_player: must be object or null');
    const p = r.featured_player as Record<string, unknown>;
    for (const k of Object.keys(p)) {
      if (!ALLOWED_PLAYER_KEYS.has(k)) throw bad(`featured_player.${k}: unknown key`);
    }
    const mode = p.mode;
    if (mode !== 'batter' && mode !== 'pitcher') throw bad('featured_player.mode: must be "batter" or "pitcher"');

    const statsIn = (p.stats ?? {}) as Record<string, unknown>;
    if (typeof statsIn !== 'object') throw bad('featured_player.stats: must be object');
    const cleanStats: Record<string, string | number | null> = {};
    for (const [k, v] of Object.entries(statsIn)) {
      if (typeof k !== 'string' || k.length > 8) throw bad(`stat key invalid: ${k}`);
      if (v == null) { cleanStats[k] = null; continue; }
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) throw bad(`stat ${k}: not finite`);
        cleanStats[k] = v;
      } else if (typeof v === 'string') {
        if (v.length > 12) throw bad(`stat ${k}: max 12 chars`);
        cleanStats[k] = v;
      } else {
        throw bad(`stat ${k}: must be number, string, or null`);
      }
    }

    featured = {
      number: clampInt(p.number ?? 0, 0, 999, 'featured_player.number'),
      mode,
      first_name: strOrEmpty(p.first_name, 40, 'featured_player.first_name'),
      last_name:  strOrEmpty(p.last_name,  40, 'featured_player.last_name'),
      position:   strOrEmpty(p.position,   20, 'featured_player.position'),
      bats:       strOrEmpty(p.bats,        2, 'featured_player.bats'),
      throws:     strOrEmpty(p.throws,      2, 'featured_player.throws'),
      photo_url:  urlOrNull(p.photo_url,        'featured_player.photo_url'),
      stats:      cleanStats
    };
  }

  let overlay_scale = 1;
  if (r.overlay_scale != null) {
    if (typeof r.overlay_scale !== 'number' || !Number.isFinite(r.overlay_scale)) {
      throw bad('overlay_scale: must be a number');
    }
    overlay_scale = Math.max(0.5, Math.min(2, r.overlay_scale));
  }

  return {
    visible: r.visible,
    overlay_scale,
    score: {
      home_name:     strOrEmpty(s.home_name, 30, 'score.home_name'),
      away_name:     strOrEmpty(s.away_name, 30, 'score.away_name'),
      home_logo_url: urlOrNull(s.home_logo_url,  'score.home_logo_url'),
      away_logo_url: urlOrNull(s.away_logo_url,  'score.away_logo_url'),
      home_runs:     clampInt(s.home_runs ?? 0, 0, 99, 'score.home_runs'),
      away_runs:     clampInt(s.away_runs ?? 0, 0, 99, 'score.away_runs'),
    },
    game: {
      inning:  clampInt(g.inning  ?? 1, 1, 20, 'game.inning'),
      half,
      balls:   clampInt(g.balls   ?? 0, 0,  3, 'game.balls'),
      strikes: clampInt(g.strikes ?? 0, 0,  2, 'game.strikes'),
      outs:    clampInt(g.outs    ?? 0, 0,  2, 'game.outs'),
      bases: {
        first:  !!bases.first,
        second: !!bases.second,
        third:  !!bases.third,
      }
    },
    featured_player: featured,
  };
}
