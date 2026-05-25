/**
 * Verify Cloudflare Access JWT — clone of cards-worker/src/auth.ts.
 * The page (admin-scorekeeper.html) attaches the cf-access-jwt-assertion
 * header sourced from the CF_Authorization cookie.
 */

import type { Env, JwtIdentity } from './types';

interface JwksCache {
  jwks: { keys: JsonWebKey[] };
  expiresAt: number;
}

const JWKS_CACHE = new Map<string, JwksCache>();
const JWKS_TTL_MS = 60 * 60 * 1000;

export async function verifyAccessJwt(request: Request, env: Env): Promise<JwtIdentity> {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) throw new Error('Missing CF Access JWT');

  const [headerB64, payloadB64, signatureB64] = token.split('.');
  if (!headerB64 || !payloadB64 || !signatureB64) throw new Error('Malformed JWT');

  const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/'))) as { kid: string; alg: string };
  const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'))) as {
    aud: string | string[];
    exp?: number;
    nbf?: number;
    email: string;
    sub: string;
  };

  const expectedAud = env.CF_ACCESS_AUD;
  if (!expectedAud) throw new Error('CF_ACCESS_AUD not configured');
  const audMatches = Array.isArray(payload.aud)
    ? payload.aud.includes(expectedAud)
    : payload.aud === expectedAud;
  if (!audMatches) throw new Error('Invalid audience');

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error('JWT expired');
  if (payload.nbf && payload.nbf > now) throw new Error('JWT not yet valid');

  const jwks = await fetchJwks(env);
  const key = jwks.keys.find((k: JsonWebKey & { kid?: string }) => k.kid === header.kid);
  if (!key) throw new Error('Signing key not found');

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    key,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = Uint8Array.from(
    atob(signatureB64.replace(/-/g, '+').replace(/_/g, '/')),
    (c) => c.charCodeAt(0)
  );

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    signature,
    data
  );

  if (!valid) throw new Error('Invalid signature');

  return { email: payload.email, sub: payload.sub };
}

async function fetchJwks(env: Env): Promise<{ keys: JsonWebKey[] }> {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  if (!teamDomain) throw new Error('CF_ACCESS_TEAM_DOMAIN not configured');
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;

  const cached = JWKS_CACHE.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.jwks;
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error('JWKS fetch failed');
  const jwks = await res.json() as { keys: JsonWebKey[] };

  JWKS_CACHE.set(url, { jwks, expiresAt: Date.now() + JWKS_TTL_MS });
  return jwks;
}
