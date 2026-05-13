export interface Env {
  DB: D1Database;
  CARDS_BUCKET: R2Bucket;
  AUTH_WORKER: Fetcher;
  BROWSER: Fetcher;
  ALLOWED_ORIGIN: string;
  ENVIRONMENT: string;
  CF_ACCESS_AUD: string;
  CF_ACCESS_TEAM_DOMAIN: string;
}

export interface AuthContext {
  email: string;
  role: string;
  teams: string[];
  isAdmin: boolean;
  canAccessTeam: (teamId: string) => boolean;
}

export interface JwtIdentity {
  email: string;
  sub: string;
}
