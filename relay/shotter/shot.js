// Shotter: screenshots OVERLAY_URL every SHOT_MS into /shared/overlay.png
// (atomic rename). Restarts the browser on any failure; the burner keeps
// streaming the last PNG regardless, so a shotter crash never kills video.
const puppeteer = require('puppeteer');
const fs = require('fs');

const URL = process.env.OVERLAY_URL;
const OUT = process.env.OUT_PNG || '/shared/overlay.png';
const SHOT_MS = parseInt(process.env.SHOT_MS || '2000', 10);
const RELOAD_MS = parseInt(process.env.RELOAD_MS || String(6 * 3600 * 1000), 10); // fresh page every 6h

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--force-device-scale-factor=1'],
    defaultViewport: { width: 1920, height: 1080 },
  });
  try {
    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
    await sleep(3000); // fonts + first KV poll
    console.log(`[shotter] page loaded: ${URL}`);
    const start = Date.now();
    let n = 0;
    while (Date.now() - start < RELOAD_MS) {
      const t0 = Date.now();
      await page.screenshot({ path: OUT + '.tmp', omitBackground: true });
      fs.renameSync(OUT + '.tmp', OUT);
      if (++n % 150 === 1) console.log(`[shotter] shot #${n} (${Date.now() - t0}ms)`);
      const wait = SHOT_MS - (Date.now() - t0);
      if (wait > 0) await sleep(wait);
    }
    console.log('[shotter] scheduled reload');
  } finally {
    await browser.close().catch(() => {});
  }
}

(async () => {
  for (;;) {
    try { await run(); }
    catch (e) { console.error('[shotter] error:', e.message); await sleep(3000); }
  }
})();
