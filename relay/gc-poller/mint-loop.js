// relay/gc-poller/mint-loop.js
//
// Token-minter sidecar. Every MINT_INTERVAL_MIN it re-logs into web.gc.com
// using the TRUSTED-DEVICE profile (PROFILE_DIR) — no emailed code needed once
// the profile has been seeded once (see seed-login.js) — and writes the fresh
// user gc-token to TOKEN_OUT as {token, device_id, minted_at, exp}. The
// gc-poller reads that file (local, instant) and falls back to the worker
// gctoken vault (Jay's manual paste) if it's missing or stale.
//
// If a mint fails (trusted-device trust expired, GC down, etc.) it LEAVES the
// last token file in place and retries sooner — the poller degrades to Tier-1
// on its own once the token actually expires. Re-seed with seed-login.js when
// the profile stops being trusted.
//
// Env: GC_EMAIL, GC_PASSWORD, PROFILE_DIR (persistent, seeded), TOKEN_OUT,
//      MINT_INTERVAL_MIN (default 45), RETRY_MIN (default 5).

'use strict';
const fs = require('fs');
const path = require('path');
const { mintToken } = require('./mint-token');

const TOKEN_OUT = process.env.TOKEN_OUT || '/shared-token/gctoken.json';
const INTERVAL_MS = Math.max(5, parseInt(process.env.MINT_INTERVAL_MIN || '45', 10)) * 60 * 1000;
const RETRY_MS = Math.max(1, parseInt(process.env.RETRY_MIN || '5', 10)) * 60 * 1000;

const log = (...a) => console.error(new Date().toISOString(), '[mint-loop]', ...a);

function jwtExp(tok) {
  try { return JSON.parse(Buffer.from(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).exp || null; }
  catch { return null; }
}

async function once() {
  const r = await mintToken();               // uses PROFILE_DIR (trusted device)
  const rec = {
    token: r.token,
    device_id: r.device_id || null,
    waf_token: r.waf_token || null,
    minted_at: r.minted_at,
    exp: jwtExp(r.token),
  };
  fs.mkdirSync(path.dirname(TOKEN_OUT), { recursive: true });
  const tmp = TOKEN_OUT + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec));
  fs.renameSync(tmp, TOKEN_OUT);             // atomic swap so the poller never reads a half file
  log(`minted user token → ${TOKEN_OUT} (exp ${rec.exp ? new Date(rec.exp * 1000).toISOString() : '?'})`);
}

(async () => {
  log(`up — profile ${process.env.PROFILE_DIR}, interval ${INTERVAL_MS / 60000}min → ${TOKEN_OUT}`);
  for (;;) {
    let wait = INTERVAL_MS;
    try {
      await once();
    } catch (e) {
      log('mint failed (keeping last token file, retrying sooner):', e.message);
      wait = RETRY_MS;
    }
    await new Promise((res) => setTimeout(res, wait));
  }
})();
