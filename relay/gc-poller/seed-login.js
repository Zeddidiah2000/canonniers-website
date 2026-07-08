// relay/gc-poller/seed-login.js
//
// ONE-TIME seeded login for the throwaway GC account. GC requires an emailed
// verification code + password (mandatory 2FA), so a fully-headless login is
// impossible. This script drives the login up to the code screen (which sends
// the email), then WAITS for the human to drop the code into /tmp/gc_code.txt,
// finishes login, and captures BOTH the user gc-token AND the refresh token
// (from the eden /auth response body). The refresh token is what lets the
// poller mint fresh gc-tokens autonomously afterward (refresh needs no code).
//
// It also persists the Chrome profile to /app-profile (userDataDir) so we can
// later test whether GC "remembers this device" and skips the code.
//
// Env: GC_EMAIL, GC_PASSWORD, CODE_FILE (default /tmp/gc_code.txt),
//      PROFILE_DIR (default /tmp/gc-profile).
// Output: JSON {gc_token, refresh_token, device_id, token_type, seeded_at} to stdout.

'use strict';
const fs = require('fs');
const puppeteer = require('puppeteer');

const LOGIN_URL = 'https://web.gc.com/login';
const API_HOST  = 'api.team-manager.gc.com';
const CODE_FILE = process.env.CODE_FILE || '/tmp/gc_code.txt';
const PROFILE_DIR = process.env.PROFILE_DIR || '/tmp/gc-profile';
const CODE_WAIT_MS = 9 * 60 * 1000;   // codes expire ~10min

const log = (...a) => console.error(new Date().toISOString(), '[seed]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jwtType = (tok) => {
  try { return JSON.parse(Buffer.from(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).type || null; }
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

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    page.setDefaultNavigationTimeout(45000);

    // user gc-token off request headers
    page.on('request', (req) => {
      try {
        if (!req.url().includes(API_HOST)) return;
        const h = req.headers();
        const tok = h['gc-token']; if (!tok || captured.gc_token) return;
        if (jwtType(tok) === 'client') return;
        captured.gc_token = tok; captured.token_type = jwtType(tok);
        captured.device_id = h['gc-device-id'] || captured.device_id;
      } catch (_) {}
    });
    // refresh token from any /auth response body
    page.on('response', async (res) => {
      try {
        if (!/\/auth(\?|$)/.test(res.url())) return;
        const j = await res.json().catch(() => null);
        if (!j) return;
        const refresh = (j.refresh && (j.refresh.data || j.refresh)) || (j.tokens && j.tokens.refresh && (j.tokens.refresh.data || j.tokens.refresh));
        if (refresh && typeof refresh === 'string' && !captured.refresh_token) { captured.refresh_token = refresh; log('captured refresh token'); }
      } catch (_) {}
    });

    log('opening login');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });
    await typeInto(page, 'input[type="email"], #email, input[autocomplete="username"]', email);
    await clickButton(page, /continue|next|suivant/);

    log('waiting for password/code screen (this sends the email code)');
    await page.waitForSelector('input[type="password"]', { visible: true, timeout: 45000 });
    await typeInto(page, 'input[type="password"]', password);

    // The code was emailed the moment the code screen rendered. Wait for the human.
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

    const codeSel = 'input[name="code"], input[type="text"]';
    await typeInto(page, codeSel, code);
    // password may have been cleared on re-render — re-assert it
    await typeInto(page, 'input[type="password"]', password);
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

    process.stdout.write(JSON.stringify({ ...captured, seeded_at: new Date().toISOString() }) + '\n');
    log(`SEED OK — token type ${captured.token_type}, refresh ${captured.refresh_token ? 'yes' : 'NO'}, device ${captured.device_id ? 'yes' : 'no'}`);
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { log('SEED FAILED:', e.message); process.exit(1); });
