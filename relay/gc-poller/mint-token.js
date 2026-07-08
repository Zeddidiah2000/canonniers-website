// relay/gc-poller/mint-token.js
//
// Log into web.gc.com with the throwaway account in a real headless Chrome and
// capture a fresh `gc-token` (+ gc-device-id, + x-aws-waf-token) off the wire.
//
// Why a browser and not a raw HTTP login: GC's auth is HMAC-signed
// (client-auth handshake + per-request signature chain), double-bcrypts the
// password, runs invisible reCAPTCHA v3, and is fronted by an AWS WAF JS
// challenge. All of that is handled for free by loading their own JS in real
// Chrome. We just watch the network for the token the app then sends.
//
// Usage (standalone, prints JSON to stdout):
//   GC_EMAIL=… GC_PASSWORD=… node mint-token.js
// Or require() it: const { mintToken } = require('./mint-token');
//
// Exit 0 + JSON {token, device_id, waf_token, minted_at} on success; exit 1 otherwise.

'use strict';

const puppeteer = require('puppeteer');

const LOGIN_URL = 'https://web.gc.com/login';
const API_HOST  = 'api.team-manager.gc.com';
const NAV_TIMEOUT = 45000;
const TOKEN_TIMEOUT = 60000;

const log = (...a) => console.error(new Date().toISOString(), '[mint]', ...a);

async function typeInto(page, selector, text) {
  await page.waitForSelector(selector, { visible: true, timeout: NAV_TIMEOUT });
  await page.focus(selector);
  // Clear anything prefilled, then type.
  await page.evaluate((s) => { const el = document.querySelector(s); if (el) el.value = ''; }, selector);
  await page.type(selector, text, { delay: 25 });
}

// Click the first visible button/[type=submit] whose text matches /re/, else
// press Enter as a fallback (the email + password steps both submit on Enter).
async function clickButton(page, re) {
  const clicked = await page.evaluate((reSrc) => {
    const rx = new RegExp(reSrc, 'i');
    const btns = [...document.querySelectorAll('button, [type=submit], [role=button]')];
    const b = btns.find((x) => rx.test((x.textContent || '').trim()) && x.offsetParent !== null && !x.disabled);
    if (b) { b.click(); return true; }
    return false;
  }, re.source);
  if (!clicked) await page.keyboard.press('Enter');
  return clicked;
}

async function mintToken({ email, password } = {}) {
  email = email || process.env.GC_EMAIL;
  password = password || process.env.GC_PASSWORD;
  if (!email || !password) throw new Error('GC_EMAIL / GC_PASSWORD required');

  const launchOpts = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1280,900',
    ],
  };
  // A persisted profile lets GC "remember this device" and skip the emailed
  // code on subsequent logins — the whole point of the autonomous path.
  if (process.env.PROFILE_DIR) launchOpts.userDataDir = process.env.PROFILE_DIR;
  const browser = await puppeteer.launch(launchOpts);

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    // A normal desktop UA so the WAF/reCAPTCHA score treats us as a browser.
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);

    // Watch every request to the GC API and grab the auth headers once the app
    // starts making USER-authed calls. The app fires a `client-auth` handshake
    // during page load whose gc-token has JWT payload type:"client" — that one
    // is NOT usable for /plays. We must wait for the post-login user token
    // (payload type !== "client"), which only appears after credentials pass.
    const captured = { token: null, device_id: null, waf_token: null };
    const jwtType = (tok) => {
      try {
        const p = JSON.parse(Buffer.from(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        return p.type || null;
      } catch { return null; }
    };
    const gotToken = new Promise((resolve) => {
      page.on('request', (req) => {
        try {
          const url = req.url();
          if (!url.includes(API_HOST)) return;
          const h = req.headers();
          const tok = h['gc-token'] || h['Gc-Token'];
          if (!tok || captured.token) return;
          const type = jwtType(tok);
          if (type === 'client') return;   // pre-login bootstrap — keep waiting
          captured.token = tok;
          captured.token_type = type;
          captured.device_id = h['gc-device-id'] || h['Gc-Device-Id'] || null;
          captured.waf_token = h['x-aws-waf-token'] || h['X-Aws-Waf-Token'] || null;
          resolve();
        } catch (_) { /* ignore */ }
      });
    });

    log('opening login page');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });

    // With a persisted (trusted-device) profile the app may already be logged
    // in — it fires authed API calls immediately and no email field appears.
    // Race: token captured (already authed) vs email field visible (must log in).
    const emailSel = 'input[type="email"], input[name="email"], #email, input[autocomplete="username"]';
    const needLogin = await Promise.race([
      gotToken.then(() => false),
      page.waitForSelector(emailSel, { visible: true, timeout: 15000 }).then(() => true).catch(() => true),
    ]);
    if (needLogin && !captured.token) {
      // Step 1: email → "Continue". GC's login is a two-step form.
      log('entering email');
      await typeInto(page, emailSel, email);
      await clickButton(page, /continue|next|suivant/);

      // Step 2: the password field renders asynchronously after the email step
      // (the app fetches the account's bcrypt salts first). Wait for it.
      log('waiting for password field');
      const pwSel = 'input[type="password"], input[name="password"], input[autocomplete="current-password"]';
      await page.waitForSelector(pwSel, { visible: true, timeout: NAV_TIMEOUT });
      log('entering password');
      await typeInto(page, pwSel, password);
      await clickButton(page, /log ?in|sign ?in|connexion|continue|submit/);
    } else {
      log('already authenticated (trusted-device profile) — no login needed');
    }

    log('waiting for user gc-token on the wire');
    await Promise.race([
      gotToken,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out waiting for user gc-token — trusted-device may have expired / code required')), TOKEN_TIMEOUT)),
    ]);

    if (!captured.token) throw new Error('no gc-token captured');
    return { ...captured, minted_at: new Date().toISOString() };
  } catch (err) {
    // Drop a screenshot + DOM snapshot to /tmp (writable) for diagnosis.
    try {
      const pages = await browser.pages();
      const p = pages[pages.length - 1];
      if (p) {
        await p.screenshot({ path: '/tmp/mint-fail.png' }).catch(() => {});
        const dom = await p.evaluate(() => ({
          url: location.href,
          inputs: [...document.querySelectorAll('input')].map((el) => ({ type: el.type, name: el.name, visible: el.offsetParent !== null })),
          bodyText: (document.body.innerText || '').slice(0, 500),
        })).catch(() => null);
        if (dom) log('DOM at failure:', JSON.stringify(dom));
      }
    } catch (_) { /* best effort */ }
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { mintToken };

if (require.main === module) {
  mintToken()
    .then((r) => {
      // token itself only to stdout as JSON; never logged in full
      process.stdout.write(JSON.stringify(r) + '\n');
      log(`OK — token type ${r.token_type}, len ${r.token.length}, device_id ${r.device_id ? 'yes' : 'no'}, waf ${r.waf_token ? 'yes' : 'no'}`);
      process.exit(0);
    })
    .catch((e) => { log('FAILED:', e.message); process.exit(1); });
}
