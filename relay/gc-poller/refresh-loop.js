// relay/gc-poller/refresh-loop.js
//
// Browserless token producer — the robust replacement for the puppeteer
// trusted-device minter (mint-loop.js). Reads a durable auth state seeded once
// by seed-login.js, then calls eden /auth {type:"refresh"} on a timer to keep a
// fresh user gc-token in TOKEN_OUT for the poller. No Chrome, so it's immune to
// the web-app-render timeouts that made the minter flaky (and leaked Chrome).
//
// The refresh token is a ~14-day sliding JWT that rotates on every call, so as
// long as this loop runs at least every 14 days it never needs re-seeding.
//
// State file (STATE_FILE, chmod 600, NOT in git — holds the refresh token +
// app clientKey):
//   { edenURL, clientId, clientKey, deviceId, refreshToken, seeded_at, updated_at }
//
// On an eden rejection of the refresh token (revoked / >14d idle) it keeps the
// last token file in place (poller degrades to Tier-1 on its own) and backs off
// — a human must re-seed with seed-login.js (or paste via admin-scorekeeper).
//
// Env: STATE_FILE (default /state/state.json), TOKEN_OUT
//      (default /shared-token/gctoken.json), REFRESH_SKEW_MIN (default 15),
//      MIN_SLEEP_MIN (default 1), RETRY_MIN (default 3).

'use strict';
const fs = require('fs');
const path = require('path');
const { refreshAccessToken, jwtPayload } = require('./gc-auth-refresh');

const STATE_FILE = process.env.STATE_FILE || '/state/state.json';
const TOKEN_OUT = process.env.TOKEN_OUT || '/shared-token/gctoken.json';
const SKEW_MS = Math.max(2, parseInt(process.env.REFRESH_SKEW_MIN || '15', 10)) * 60 * 1000;
const MIN_SLEEP_MS = Math.max(1, parseInt(process.env.MIN_SLEEP_MIN || '1', 10)) * 60 * 1000;
const RETRY_MS = Math.max(1, parseInt(process.env.RETRY_MIN || '3', 10)) * 60 * 1000;

const log = (...a) => console.error(new Date().toISOString(), '[refresh-loop]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadState() {
  const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  for (const k of ['edenURL', 'clientId', 'clientKey', 'refreshToken']) {
    if (!s[k]) throw new Error(`state missing ${k} — re-seed with seed-login.js`);
  }
  return s;
}

// Atomic write so a reader never sees a half file.
function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

// Persist the rotated refresh token back into the state file (keep everything
// else). Losing a rotation would strand us on a stale refresh token, so this
// must succeed before we consider the refresh "done".
function persistRefreshToken(state, newRefresh) {
  if (!newRefresh || newRefresh === state.refreshToken) return;
  state.refreshToken = newRefresh;
  state.updated_at = new Date().toISOString();
  writeAtomic(STATE_FILE, state);
}

async function once(state) {
  const r = await refreshAccessToken(state);
  if (!r.ok) {
    const err = new Error(`eden refused refresh (HTTP ${r.status}): ${r.body}`);
    err.status = r.status;
    throw err;
  }
  // Persist the rotated refresh token FIRST — never lose the chain.
  persistRefreshToken(state, r.refreshToken);
  const rec = {
    token: r.accessToken,
    device_id: r.deviceId || state.deviceId || null,
    minted_at: new Date().toISOString(),
    exp: r.accessExp || (jwtPayload(r.accessToken) || {}).exp || null,
    source: 'refresh',
  };
  writeAtomic(TOKEN_OUT, rec);
  return rec;
}

// Sleep until the access token is SKEW_MS from expiry (clamped to >= MIN_SLEEP_MS).
function nextDelay(rec) {
  const exp = rec && rec.exp ? rec.exp * 1000 : 0;
  return Math.max(MIN_SLEEP_MS, exp - Date.now() - SKEW_MS);
}

(async () => {
  let state;
  try { state = loadState(); }
  catch (e) { log('FATAL — cannot load state:', e.message); process.exit(1); }
  log(`up — eden ${state.edenURL}, client ${state.clientId}, device ${state.deviceId || '(none)'}, out ${TOKEN_OUT}`);

  for (;;) {
    let wait = RETRY_MS;
    try {
      const rec = await once(state);
      wait = nextDelay(rec);
      log(`token refreshed (exp ${rec.exp ? new Date(rec.exp * 1000).toISOString() : '?'}); next in ${Math.round(wait / 60000)}min`);
    } catch (e) {
      // 401/403 = the refresh token itself is dead → back off hard; a human must
      // re-seed. Anything else (network, 5xx) = transient → retry sooner. Either
      // way keep the last TOKEN_OUT so the poller can ride out its 60-min TTL.
      if (e.status === 401 || e.status === 403) { wait = 30 * 60 * 1000; log('REFRESH TOKEN DEAD — re-seed needed (seed-login.js). Backing off 30min:', e.message); }
      else log('refresh failed (keeping last token, retrying sooner):', e.message);
    }
    await sleep(wait);
  }
})();
