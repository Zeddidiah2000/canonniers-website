// relay/gc-poller/gc-auth-refresh.js
//
// Browserless GameChanger token refresh. GC's web app signs every eden /auth
// request with an HMAC-SHA256 over {timestamp, nonce, previousSignature?} +
// the request body's flattened values, keyed by the app-global clientKey. The
// {type:"refresh"} call is standalone (usePreviousSignature:false, no prior
// handshake) and takes the refresh token as the `gc-token` header, so we can
// mint fresh user access tokens from plain Node — no Chrome, immune to the
// web-app-render failures that plague the puppeteer minter.
//
// Reverse-engineered from web.gc.com/assets/gamechanger-auth-*.js (2026-07-08);
// signPayload is byte-verified identical to their crypto-js impl and accepted
// live by eden (HTTP 200 + signed response). See DIRECTIVE-overlay-relay.md.
//
//   const { refreshAccessToken } = require('./gc-auth-refresh');
//   const r = await refreshAccessToken({ edenURL, clientId, clientKey, deviceId, refreshToken });
//   // r = { accessToken, refreshToken (ROTATED — persist it), accessExp }
//
// The refresh token is itself a ~14-day JWT that rotates on every call, so a
// loop refreshing more often than every 14 days never needs re-seeding.

'use strict';
const crypto = require('crypto');

// valuesForSigner: flatten a JSON value to the ordered string list GC signs.
// Objects: keys sorted, values recursed. Arrays: flat-mapped. number->String,
// string->itself, undefined->dropped, null-object->["null"]. (Verbatim port.)
function valuesForSigner(a) {
  if (Array.isArray(a)) return a.flatMap(valuesForSigner);
  switch (typeof a) {
    case 'object': return (a && Object.keys(a).sort().flatMap((n) => valuesForSigner(a[n]))) || ['null'];
    case 'string': return [a];
    case 'number': return ['' + a];
    case 'undefined': return [];
  }
  throw new Error('Unknown type: ' + typeof a);
}

// HMAC-SHA256(base64-decode(clientKey)) over
//   `${timestamp}|` + rawBytes(nonce) + `|` + values.join('|') [+ `|` + rawBytes(prevSig)]
// returned base64. nonce/previousSignature are base64 strings (decoded to bytes).
function signPayload(clientKeyB64, sig, payload) {
  const h = crypto.createHmac('sha256', Buffer.from(clientKeyB64, 'base64'));
  h.update(Buffer.from(String(sig.timestamp) + '|', 'utf8'));
  h.update(Buffer.from(sig.nonce, 'base64'));
  h.update(Buffer.from('|', 'utf8'));
  h.update(Buffer.from(valuesForSigner(payload).join('|'), 'utf8'));
  if (sig.previousSignature) {
    h.update(Buffer.from('|', 'utf8'));
    h.update(Buffer.from(sig.previousSignature, 'base64'));
  }
  return h.digest('base64');
}

function jwtPayload(tok) {
  try { return JSON.parse(Buffer.from(String(tok).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
  catch { return null; }
}

// Perform one refresh. Throws on network error; returns { ok:false, status } on
// an eden rejection (e.g. dead/expired refresh token), { ok:true, ... } on 200.
async function refreshAccessToken({ edenURL, clientId, clientKey, deviceId, refreshToken, timeoutMs = 8000 }) {
  if (!edenURL || !clientId || !clientKey || !refreshToken) throw new Error('edenURL, clientId, clientKey, refreshToken required');
  const timestamp = Math.floor(Date.now() / 1000);      // GC getTimestamp() = seconds
  const nonce = crypto.randomBytes(32).toString('base64');
  const payload = { type: 'refresh' };
  const sig = signPayload(clientKey, { timestamp, nonce }, payload);   // usePreviousSignature:false
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'gc-app-name': 'web',
    'gc-app-version': '0.0.0',
    'gc-client-id': clientId,
    'gc-timestamp': String(timestamp),
    'gc-signature': `${nonce}.${sig}`,
    'gc-token': refreshToken,                            // refresh token as gc-token (SDK: token.data)
  };
  if (deviceId) headers['gc-device-id'] = deviceId;

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try { res = await fetch(edenURL + '/auth', { method: 'POST', headers, body: JSON.stringify(payload), signal: ac.signal }); }
  finally { clearTimeout(t); }

  if (res.status !== 200) {
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, body: body.slice(0, 200) };
  }
  const j = await res.json().catch(() => null);
  if (!j || j.type !== 'token' || !j.access || !j.access.data) {
    return { ok: false, status: res.status, body: 'unexpected 200 body: ' + JSON.stringify(j).slice(0, 200) };
  }
  const accessToken = j.access.data;
  const p = jwtPayload(accessToken);
  return {
    ok: true,
    accessToken,
    refreshToken: (j.refresh && j.refresh.data) || refreshToken,   // ROTATED — caller must persist
    accessExp: (p && p.exp) || (j.access.expires) || null,
    refreshExp: (j.refresh && j.refresh.expires) || null,
    deviceId: deviceId || null,
  };
}

module.exports = { valuesForSigner, signPayload, jwtPayload, refreshAccessToken };

// ── Offline self-test (node gc-auth-refresh.js --selftest) ──────────────────
// Frozen regression vectors (computed from the live-verified signer). If GC
// ever changes the signing scheme these break loudly at container build.
if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert');
  const KEY = 'Q3ZVbZjwSa7WV0bPIxscAmZNi0AO0WYy6KyHpO3NGLM=';
  const TS = 1783550467;
  const NONCE = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  assert.strictEqual(signPayload(KEY, { timestamp: TS, nonce: NONCE }, { type: 'refresh' }),
    'eiYnNVBPUYNbpX4FG36Et3Jngjt2Okcz2DIivxu9UHU=');
  assert.strictEqual(signPayload(KEY, { timestamp: TS, nonce: NONCE }, { type: 'client-auth', client_id: 'f111c389-68a4-47ee-8b52-7cf995fd2549' }),
    '480r8IwCKOuTbpDvaQHnb7BRsdOwrwRQ9F0ZWKqaZg8=');
  assert.strictEqual(signPayload(KEY, { timestamp: TS, nonce: NONCE, previousSignature: 'Ym9ndXNwcmV2c2lnbmF0dXJlYm9ndXNwcmV2c2lnMDA=' }, { type: 'refresh' }),
    '9xyU3yXdNVLaQO48oRdtxI/VURcxffUtP9CD/ClTxV0=');
  // valuesForSigner: keys sorted, arrays flat, undefined dropped, nested recursed.
  assert.deepStrictEqual(valuesForSigner({ b: 2, a: 'x', c: [{ y: 9, x: 8 }, 'z'], d: undefined }), ['x', '2', '8', '9', 'z']);
  console.log('gc-auth-refresh selftest OK');
}
