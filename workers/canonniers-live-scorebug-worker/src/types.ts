export interface Env {
  SCOREBUG: KVNamespace;
  ALLOWED_ORIGIN: string;
  CF_ACCESS_AUD: string;
  CF_ACCESS_TEAM_DOMAIN: string;
}

export interface JwtIdentity {
  email: string;
  sub: string;
}

export type Half = 'top' | 'bottom';

export interface ScoreState {
  visible: boolean;
  score: {
    home_name: string;
    away_name: string;
    away_logo_url: string | null;
    home_runs: number;
    away_runs: number;
  };
  game: {
    inning: number;
    half: Half;
    balls: number;
    strikes: number;
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
  updated_at: string;
  version: 1;
}
