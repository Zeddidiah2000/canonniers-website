export interface Env {
  SCOREBUG: KVNamespace;
  SPORDLE_PROXY: Fetcher;
  ALLOWED_ORIGIN: string;
  SPORDLE_OFFICE_ID: string;
  SPORDLE_TEAM_ID_U15: string;
  SPORDLE_TEAM_ID_U17D1: string;
  SPORDLE_TEAM_ID_U17D2: string;
  CF_ACCESS_AUD: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  POLLER_TOKEN: string;
}

export interface JwtIdentity {
  email: string;
  sub: string;
}

export type Half = 'top' | 'bottom';

// 'auto'   — the VPS gc-poller drives the state (default).
// 'manual' — a human on admin-scorekeeper.html has taken over; the poller
//            must not write until the page flips back to 'auto'.
export type Mode = 'auto' | 'manual';

// Written by the poller so admin-scorekeeper.html can show token health.
export type GcTokenStatus = 'ok' | 'expired' | 'absent';

export interface ScoreState {
  visible: boolean;
  mode: Mode;
  score: {
    home_name: string;
    away_name: string;
    home_logo_url: string | null;
    away_logo_url: string | null;
    home_runs: number;
    away_runs: number;
  };
  game: {
    inning: number;
    half: Half;
    // null = unknown (Tier-1 auto mode) — scorebug.html hides the count.
    balls: number | null;
    strikes: number | null;
    outs: number;
    bases: { first: boolean; second: boolean; third: boolean };
  };
  featured_player: null | {
    number: number;
    mode: 'batter' | 'pitcher';
    first_name: string;
    last_name: string;
    position: string;
    bats: string;
    throws: string;
    photo_url: string | null;
    stats: Record<string, string | number | null>;
  };
  overlay_scale: number;
  gc_token_status?: GcTokenStatus;
  auto_updated_at?: string | null;
  updated_at: string;
  version: 1;
}

// KV record under `gctoken:{team}` — Jay pastes it from a logged-in
// web.gc.com DevTools session (device_id / waf_token from the same request's
// headers; optional but improve Tier-2 acceptance).
export interface GcTokenRecord {
  token: string;
  device_id: string | null;
  waf_token: string | null;
  saved_at: string;
}
