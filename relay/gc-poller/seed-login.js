// relay/gc-poller/seed-login.js
//
// ONE-TIME seeded login for the throwaway GC account. GC requires an emailed
// verification code + password (mandatory 2FA), so a fully-headless login is
// impossible. This script drives the login up to the code screen (which sends
// the email), waits for the human to drop the code into CODE_FILE, finishes
// login, and captures the user gc-token + the long-lived refresh token (from
// the eden /auth response body).
//
// It ALSO harvests the app-global eden auth constants (edenURL, clientId,
// clientKey) off the pre-login `client-auth` handshake — clientKey is resolved
// by reproducing that request's real gc-signature against base64 candidates
// scraped from the page/responses, so it's provably correct and self-heals if
// GC rotates the key. With STATE_FILE set it writes the complete durable state
// the browserless refresh-loop needs:
//   { edenURL, clientId, clientKey, deviceId, refreshToken, seeded_at }
//
// After this runs once, refresh-loop.js keeps minting tokens with NO browser
// for ~14 days (the refresh token's sliding lifetime) before a re-seed is due.
//
// Env: GC_EMAIL, GC_PASSWORD, CODE_FILE (default /tmp/gc_code.txt),
//      PROFILE_DIR (default /tmp/gc-profile), STATE_FILE (optional; write it).
// Output: JSON {gc_token, refresh_token, device_id, token_type, clientKey_found,
//               state_written, seeded_at} to stdout.

'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { signPayload } = require('./gc-auth-refresh');

const LOGIN_URL = 'https://web.gc.com/login';
const API_HOST  = 'api.team-manager.gc.com';
const CODE_FILE = process.env.CODE_FILE || '/tmp/gc_code.txt';
const PROFILE_DIR = process.env.PROFILE_DIR || '/tmp/gc-profile';
const STATE_FILE = process.env.STATE_FILE || '';
const CODE_WAIT_MS = 9 * 60 * 1000;   // codes expire ~10min

const log = (...a) => console.error(new Date().toISOString(), '[seed]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jwtType = (tok) => {
  try { return JSON.parse(Buffer.from(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).type || null; }
  catch { return null; }
};

async function typeInto(page, selector, text) {
  await page.waitForSelector(selector, { visible: true, timeout: 45000 });
  await page.focus(selector);
  await page.evaluate((s) => { const el = document.querySelector(s); if (el) el.value = ''; }, selector);
  await page.type(selector, text, { delay: 25 });
}
async function clickButton(page, re) {
  const clicked = await page.evaluate((reSrc) => {
    const rx = new RegExp(reSrc, 'i');
    const b = [...document.querySelectorAll('button,[type=submit],[role=button]')]
      .find((x) => rx.test((x.textContent || '').trim()) && x.offsetParent !== null && !x.disabled);
    if (b) { b.click(); return true; }
    return false;
  }, re.source);
  if (!clicked) await page.keyboard.press('Enter');
}

(async () => {
  const email = process.env.GC_EMAIL, password = process.env.GC_PASSWORD;
  if (!email || !password) throw new Error('GC_EMAIL / GC_PASSWORD required');
  try { fs.unlinkSync(CODE_FILE); } catch (_) {}

  const browser = await puppeteer.launch({
    headless: 'new',
    userDataDir: PROFILE_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900'],
  });
  const captured = { gc_token: null, refresh_token: null, device_id: null, token_type: null };
  // eden auth constants + the client-auth signing vector used to verify clientKey.
  const consts = { edenURL: null, clientId: null };
  let authVector = null;                 // { timestamp, nonce, sig, body }
  const candidates = new Set();          // base64 clientKey candidates
  const B64 = /[A-Za-z0-9+/]{20,}={0,2}/g;
  const addCands = (s) => { if (typeof s === 'string') for (const m of s.matchAll(B64)) candidates.add(m[0]); };

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    page.setDefaultNavigationTimeout(45000);

    page.on('request', (req) => {
      try {
        const u = req.url();
        // user gc-token off any authed API request header
        if (u.includes(API_HOST)) {
          const h = req.headers();
          const tok = h['gc-token'];
          if (tok && !captured.gc_token && jwtType(tok) !== 'client') {
            captured.gc_token = tok; captured.token_type = jwtType(tok);
            captured.device_id = h['gc-device-id'] || captured.device_id;
          }
          // client-auth signing vector → edenURL / clientId + clientKey verification
          if (/\/auth(\?|$)/.test(u) && !authVector) {
            const gcsig = h['gc-signature'] || '';
            const dot = gcsig.indexOf('.');
            let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
            if (dot > 0 && body && body.type === 'client-auth') {
              consts.edenURL = u.replace(/\/auth(\?.*)?$/, '');
              consts.clientId = h['gc-client-id'] || body.client_id || null;
              captured.device_id = captured.device_id || h['gc-device-id'] || null;
              authVector = { timestamp: h['gc-timestamp'], nonce: gcsig.slice(0, dot), sig: gcsig.slice(dot + 1), body };
            }
          }
        }
      } catch (_) {}
    });
    // refresh token + clientKey candidates from /auth (and other) response bodies
    page.on('response', async (res) => {
      try {
        const u = res.url();
        if (/\/auth(\?|$)/.test(u)) {
          const j = await res.json().catch(() => null);
          if (j) {
            const refresh = (j.refresh && (j.refresh.data || j.refresh)) || (j.tokens && j.tokens.refresh && (j.tokens.refresh.data || j.tokens.refresh));
            if (refresh && typeof refresh === 'string' && !captured.refresh_token) { captured.refresh_token = refresh; log('captured refresh token'); }
            addCands(JSON.stringify(j));
          }
          return;
        }
        const ct = res.headers()['content-type'] || '';
        if (/json|javascript|text/.test(ct)) addCands(await res.text().catch(() => ''));
      } catch (_) {}
    });

    log('opening login');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });
    await typeInto(page, 'input[type="email"], #email, input[autocomplete="username"]', email);
    await clickButton(page, /continue|next|suivant/);

    log('waiting for password/code screen (this sends the email code)');
    await page.waitForSelector('input[type="password"]', { visible: true, timeout: 45000 });
    await typeInto(page, 'input[type="password"]', password);

    log(`>>> WAITING for the emailed code in ${CODE_FILE} (up to 9 min) <<<`);
    const deadline = Date.now() + CODE_WAIT_MS;
    let code = null;
    while (Date.now() < deadline) {
      if (fs.existsSync(CODE_FILE)) {
        const c = fs.readFileSync(CODE_FILE, 'utf8').trim();
        if (/^\d{4,8}$/.test(c)) { code = c; break; }
      }
      await sleep(2000);
    }
    if (!code) throw new Error('no code arrived within 9 min');
    log('got code, submitting');

    await typeInto(page, 'input[name="code"], input[type="text"]', code);
    await typeInto(page, 'input[type="password"]', password);   // may have re-rendered
    await clickButton(page, /sign ?in|log ?in|connexion|submit|continue/);

    log('waiting for user token + refresh');
    const okDeadline = Date.now() + 60000;
    while (Date.now() < okDeadline) {
      if (captured.gc_token && captured.refresh_token) break;
      await sleep(1000);
    }
    if (!captured.gc_token) {
      const body = await page.evaluate(() => (document.body.innerText || '').slice(0, 300)).catch(() => '');
      throw new Error('login did not yield a user token; page says: ' + body);
    }

    // Resolve clientKey by reproducing the real client-auth signature.
    let clientKey = null;
    if (authVector) {
      const pageStrings = await page.evaluate(() => {
        const out = [];
        try { for (let i = 0; i < localStorage.length; i++) out.push(localStorage.getItem(localStorage.key(i))); } catch (_) {}
        try { for (let i = 0; i < sessionStorage.length; i++) out.push(sessionStorage.getItem(sessionStorage.key(i))); } catch (_) {}
        return out;
      }).catch(() => []);
      pageStrings.forEach(addCands);
      for (const c of candidates) {
        try { if (signPayload(c, { timestamp: authVector.timestamp, nonce: authVector.nonce }, authVector.body) === authVector.sig) { clientKey = c; break; } } catch (_) {}
      }
      log(clientKey ? `clientKey resolved (of ${candidates.size} candidates)` : `clientKey NOT resolved (${candidates.size} candidates tried)`);
    } else {
      log('no client-auth vector captured — clientKey unresolved');
    }

    let state_written = false;
    if (STATE_FILE) {
      if (!consts.edenURL || !consts.clientId || !clientKey) {
        log('WARNING: incomplete constants — NOT writing state (edenURL/clientId/clientKey required)');
      } else {
        const state = {
          edenURL: consts.edenURL, clientId: consts.clientId, clientKey,
          deviceId: captured.device_id, refreshToken: captured.refresh_token,
          seeded_at: new Date().toISOString(),
        };
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, STATE_FILE);
        try { fs.chmodSync(STATE_FILE, 0o600); } catch (_) {}
        state_written = true;
        log(`state written → ${STATE_FILE}`);
      }
    }

    process.stdout.write(JSON.stringify({
      gc_token: captured.gc_token, refresh_token: captured.refresh_token,
      device_id: captured.device_id, token_type: captured.token_type,
      edenURL: consts.edenURL, clientId: consts.clientId,
      clientKey_found: !!clientKey, state_written,
      seeded_at: new Date().toISOString(),
    }) + '\n');
    log(`SEED OK — token ${captured.token_type}, refresh ${captured.refresh_token ? 'yes' : 'NO'}, device ${captured.device_id ? 'yes' : 'no'}, clientKey ${clientKey ? 'yes' : 'NO'}, state ${state_written ? 'written' : 'skipped'}`);
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { log('SEED FAILED:', e.message); process.exit(1); });
