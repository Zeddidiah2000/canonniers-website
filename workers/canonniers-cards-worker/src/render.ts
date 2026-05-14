/**
 * POST /render handler — D02
 *
 * Renders a game-day card via Cloudflare Browser Rendering (Puppeteer),
 * stores the PNG in R2, and caches the result in D1 by content hash.
 */

import puppeteer from '@cloudflare/puppeteer';
import { jsonResponse, errorResponse } from './http';
import type { Env, AuthContext } from './types';

// D07 commit 7: roles authorized to render cards via the compose flow.
const COMPOSE_RENDER_ROLES = new Set(['admin', 'coach', 'social']);

// ---------- Types ----------

interface Cutout {
  image_url: string;
  preset:
    | 'bottom-right'
    | 'bottom-center'
    | 'right-tall'
    | 'right-action'
    | 'center-top-tall'
    | 'behind-score-band'
    | 'left-half-tall';
  x_offset?: number;
  y_offset?: number;
  scale_override?: number;
}

interface RenderContent {
  opponent_name: string;
  opponent_logo_url?: string | null;
  game_date: string;
  game_time?: string | null;
  venue_name?: string | null;
  is_home?: boolean;
  language: 'fr' | 'en';
  cutouts?: Cutout[];
  // Result-template fields (ignored by other templates)
  title_line_1?: string | null;
  title_line_2?: string | null;
  title_pill_text?: string | null;
  score_canonniers?: number | null;
  score_opponent?: number | null;
  vs_divider_text?: string | null;
}

interface RenderRequest {
  template: 'game-day' | 'game-day-v2' | 'blueprint' | 'result' | 'hype';
  variant: 'with-cutout' | 'graphic-only';
  team_id: 'u15' | 'u17d1' | 'u17d2';
  game_id?: number | null;
  content: RenderContent;
}

// ---------- Validation ----------

function validateRenderRequest(body: unknown): { ok: true; data: RenderRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body must be a JSON object' };
  const b = body as Record<string, unknown>;

  if (!['game-day', 'game-day-v2', 'blueprint', 'result', 'hype'].includes(b['template'] as string)) return { ok: false, error: 'Unsupported template' };
  if (!['with-cutout', 'graphic-only'].includes(b['variant'] as string)) return { ok: false, error: 'Invalid variant' };
  if (!['u15', 'u17d1', 'u17d2'].includes(b['team_id'] as string)) return { ok: false, error: 'Invalid team_id' };

  const c = b['content'] as Record<string, unknown> | undefined;
  if (!c || typeof c !== 'object') return { ok: false, error: 'content required' };
  if (typeof c['opponent_name'] !== 'string' || !(c['opponent_name'] as string).trim()) {
    return { ok: false, error: 'opponent_name required' };
  }
  if ((c['opponent_name'] as string).length > 80) return { ok: false, error: 'opponent_name too long (max 80)' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c['game_date'] as string)) return { ok: false, error: 'game_date must be YYYY-MM-DD' };
  if (c['game_time'] != null && !/^\d{2}:\d{2}$/.test(c['game_time'] as string)) {
    return { ok: false, error: 'game_time must be HH:MM' };
  }
  if (!['fr', 'en'].includes(c['language'] as string)) return { ok: false, error: 'language must be fr or en' };

  if (c['cutouts'] != null) {
    if (!Array.isArray(c['cutouts'])) return { ok: false, error: 'cutouts must be an array' };
    if ((c['cutouts'] as unknown[]).length > 2) return { ok: false, error: 'cutouts max length is 2' };
    if (b['variant'] === 'graphic-only' && (c['cutouts'] as unknown[]).length > 0) {
      return { ok: false, error: 'graphic-only variant cannot have cutouts' };
    }
    if (b['variant'] === 'with-cutout' && (c['cutouts'] as unknown[]).length === 0) {
      return { ok: false, error: 'with-cutout variant requires at least one cutout' };
    }
    const validPresets = [
      'bottom-right', 'bottom-center', 'right-tall', 'right-action',
      'center-top-tall', 'behind-score-band', 'left-half-tall',
    ];
    for (const co of c['cutouts'] as Record<string, unknown>[]) {
      if (typeof co['image_url'] !== 'string' || !(co['image_url'] as string).startsWith('https://')) {
        return { ok: false, error: 'cutout image_url must be https URL' };
      }
      if (!validPresets.includes(co['preset'] as string)) return { ok: false, error: 'invalid cutout preset' };
    }
  }

  if (c['opponent_logo_url'] != null
      && typeof c['opponent_logo_url'] === 'string'
      && !(c['opponent_logo_url'] as string).startsWith('https://')) {
    return { ok: false, error: 'opponent_logo_url must be https URL' };
  }

  // Result-template specific fields
  if (b['template'] === 'result') {
    if (typeof c['title_line_1'] !== 'string' || !(c['title_line_1'] as string).trim()) {
      return { ok: false, error: 'title_line_1 required for result template' };
    }
    if ((c['title_line_1'] as string).length > 80) return { ok: false, error: 'title_line_1 too long (max 80)' };
  }
  if (c['title_line_2'] != null) {
    if (typeof c['title_line_2'] !== 'string') return { ok: false, error: 'title_line_2 must be string' };
    if ((c['title_line_2'] as string).length > 80) return { ok: false, error: 'title_line_2 too long (max 80)' };
  }
  if (c['title_pill_text'] != null) {
    if (typeof c['title_pill_text'] !== 'string') return { ok: false, error: 'title_pill_text must be string' };
    if ((c['title_pill_text'] as string).length > 40) return { ok: false, error: 'title_pill_text too long (max 40)' };
  }
  if (c['vs_divider_text'] != null) {
    if (typeof c['vs_divider_text'] !== 'string') return { ok: false, error: 'vs_divider_text must be string' };
    if ((c['vs_divider_text'] as string).length > 20) return { ok: false, error: 'vs_divider_text too long (max 20)' };
  }
  for (const k of ['score_canonniers', 'score_opponent'] as const) {
    if (c[k] != null) {
      if (typeof c[k] !== 'number' || !Number.isInteger(c[k]) || (c[k] as number) < 0 || (c[k] as number) > 999) {
        return { ok: false, error: `${k} must be integer 0-999` };
      }
    }
  }

  return { ok: true, data: body as RenderRequest };
}

// ---------- Content hashing ----------

async function computeContentHash(req: RenderRequest): Promise<string> {
  const canonical = canonicalize({
    template: req.template,
    variant: req.variant,
    team_id: req.team_id,
    content: {
      opponent_name: req.content.opponent_name.trim(),
      opponent_logo_url: req.content.opponent_logo_url ?? null,
      game_date: req.content.game_date,
      game_time: req.content.game_time ?? null,
      venue_name: req.content.venue_name ?? null,
      is_home: req.content.is_home !== false,
      language: req.content.language,
      cutouts: (req.content.cutouts ?? []).map((c) => ({
        image_url: c.image_url,
        preset: c.preset,
        x_offset: c.x_offset ?? 0,
        y_offset: c.y_offset ?? 0,
        scale_override: c.scale_override ?? 1,
      })),
      title_line_1: req.content.title_line_1 ?? null,
      title_line_2: req.content.title_line_2 ?? null,
      title_pill_text: req.content.title_pill_text ?? null,
      score_canonniers: req.content.score_canonniers ?? null,
      score_opponent: req.content.score_opponent ?? null,
      vs_divider_text: req.content.vs_divider_text ?? null,
    },
  });
  const data = new TextEncoder().encode(canonical);
  const hashBuf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function canonicalize(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + (obj as unknown[]).map(canonicalize).join(',') + ']';
  const keys = Object.keys(obj as object).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize((obj as Record<string, unknown>)[k])).join(',') + '}';
}

// ---------- HTML escaping & template rendering ----------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderTemplate(html: string, vars: Record<string, unknown>): string {
  // Handle {{#if key}}...{{/if}} blocks
  html = html.replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key: string, body: string) => {
    return vars[key] ? body : '';
  });
  // Handle {{{key}}} (raw HTML, no escape)
  html = html.replace(/\{\{\{(\w+)\}\}\}/g, (_, key: string) => {
    const v = vars[key];
    return v == null ? '' : String(v);
  });
  // Handle {{key}} (HTML-escaped)
  html = html.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const v = vars[key];
    return v == null ? '' : escapeHtml(String(v));
  });
  return html;
}

// ---------- Localization ----------

const DAYS_FR = ['DIMANCHE', 'LUNDI', 'MARDI', 'MERCREDI', 'JEUDI', 'VENDREDI', 'SAMEDI'];
const DAYS_EN = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTHS_FR = ['JANVIER', 'FÉVRIER', 'MARS', 'AVRIL', 'MAI', 'JUIN', 'JUILLET', 'AOÛT', 'SEPTEMBRE', 'OCTOBRE', 'NOVEMBRE', 'DÉCEMBRE'];
const MONTHS_EN = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

function formatDate(isoDate: string, lang: 'fr' | 'en'): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayIdx = dt.getUTCDay();
  if (lang === 'fr') {
    return `${DAYS_FR[dayIdx]} ${d} ${MONTHS_FR[m - 1]}`;
  }
  return `${DAYS_EN[dayIdx]} ${MONTHS_EN[m - 1]} ${d}`;
}

const LABELS = {
  fr: { game_day: 'JOUR DE MATCH', vs_home: 'VS.', vs_away: '@', tbd: 'À DÉTERMINER' },
  en: { game_day: 'GAME DAY', vs_home: 'VS.', vs_away: '@', tbd: 'TBD' },
} as const;

// ---------- Opponent name tiering ----------

function opponentNameClass(name: string): string {
  const len = name.length;
  if (len <= 18) return 'tier1';
  if (len <= 32) return 'tier2';
  return 'tier3';
}

// ---------- Cutout HTML ----------

interface CutoutPreset {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  anchor: string; // {top|center|bottom}-{left|center|right}
  max_height: number;
}

const CUTOUT_PRESETS: Record<string, CutoutPreset> = {
  'bottom-right':       { x: 540, y: 540,  scale: 1.00, rotation: 0,  anchor: 'bottom-left',   max_height: 800  },
  'bottom-center':      { x: 340, y: 540,  scale: 1.00, rotation: 0,  anchor: 'bottom-left',   max_height: 800  },
  'right-tall':         { x: 600, y: 200,  scale: 1.10, rotation: 0,  anchor: 'top-left',      max_height: 800  },
  'right-action':       { x: 480, y: 280,  scale: 1.05, rotation: -3, anchor: 'top-left',      max_height: 800  },
  'center-top-tall':    { x: 540, y: 60,   scale: 1.00, rotation: 0,  anchor: 'top-center',    max_height: 920  },
  'behind-score-band':  { x: 540, y: 870,  scale: 1.00, rotation: 0,  anchor: 'bottom-center', max_height: 680  },
  'left-half-tall':     { x: 20,  y: 1080, scale: 1.00, rotation: 0,  anchor: 'bottom-left',   max_height: 860  },
};

function anchorToTranslate(anchor: string): string {
  const [v, h] = anchor.split('-');
  const ty = v === 'bottom' ? '-100%' : v === 'center' ? '-50%' : '0';
  const tx = h === 'right' ? '-100%' : h === 'center' ? '-50%' : '0';
  return `${tx}, ${ty}`;
}

function renderCutoutsHtml(cutouts: Cutout[]): string {
  return cutouts.map((co) => {
    const preset = CUTOUT_PRESETS[co.preset]!;
    const x = preset.x + (co.x_offset ?? 0);
    const y = preset.y + (co.y_offset ?? 0);
    const scale = preset.scale * (co.scale_override ?? 1);
    const transform = `translate(${anchorToTranslate(preset.anchor)}) scale(${scale}) rotate(${preset.rotation}deg)`;
    return `<img class="cutout" src="${escapeHtml(co.image_url)}" style="left: ${x}px; top: ${y}px; transform: ${transform}; transform-origin: top left; max-height: ${preset.max_height}px;">`;
  }).join('\n');
}

// ---------- Template variable bag ----------

function buildTemplateVars(req: RenderRequest): Record<string, unknown> {
  const lang = req.content.language;
  const isHome = req.content.is_home !== false;
  const labels = LABELS[lang];
  const hasLogo = !!(req.content.opponent_logo_url?.trim());
  const hasVenue = !!(req.content.venue_name?.trim());
  const time = req.content.game_time ?? labels.tbd;

  const titleLine2 = req.content.title_line_2?.trim() ?? '';
  const titlePill = req.content.title_pill_text?.trim() ?? '';
  const vsDivider = req.content.vs_divider_text?.trim() ?? 'FINAL';
  const scoreC = req.content.score_canonniers;
  const scoreO = req.content.score_opponent;

  return {
    lang,
    label_game_day: labels.game_day,
    label_vs: isHome ? labels.vs_home : labels.vs_away,
    label_tbd: labels.tbd,
    opponent_name: req.content.opponent_name.trim(),
    opponent_name_class: opponentNameClass(req.content.opponent_name.trim()),
    opponent_logo_url: req.content.opponent_logo_url ?? '',
    has_opponent_logo: hasLogo,
    not_has_opponent_logo: !hasLogo,
    date_formatted: formatDate(req.content.game_date, lang),
    time_formatted: time,
    venue_name: req.content.venue_name ?? '',
    has_venue: hasVenue,
    cutouts_html:
      req.variant === 'with-cutout' && req.content.cutouts
        ? renderCutoutsHtml(req.content.cutouts)
        : '',
    title_line_1: req.content.title_line_1?.trim() ?? '',
    title_line_2: titleLine2,
    has_title_line_2: !!titleLine2,
    title_pill_text: titlePill,
    has_title_pill: !!titlePill,
    score_canonniers: scoreC != null ? String(scoreC) : '—',
    score_opponent: scoreO != null ? String(scoreO) : '—',
    vs_divider_text: vsDivider,
  };
}

// ---------- Template + font fetching from R2 ----------

const templateCache = new Map<string, { html: string; fetched_at: number }>();
const fontB64Cache = new Map<string, { data: string; fetched_at: number }>();
const TEMPLATE_CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchTemplate(env: Env, templateName: string, variant: string): Promise<string> {
  const key = `templates/cards/${templateName}/${variant}.html`;
  const cached = templateCache.get(key);
  if (cached && Date.now() - cached.fetched_at < TEMPLATE_CACHE_TTL_MS) {
    return cached.html;
  }
  const obj = await env.CARDS_BUCKET.get(key);
  if (!obj) throw new Error(`Template not found in R2: ${key}`);
  const html = await obj.text();
  templateCache.set(key, { html, fetched_at: Date.now() });
  return html;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function fetchFontBase64(env: Env, r2Key: string): Promise<string> {
  const cached = fontB64Cache.get(r2Key);
  if (cached && Date.now() - cached.fetched_at < TEMPLATE_CACHE_TTL_MS) {
    return cached.data;
  }
  const obj = await env.CARDS_BUCKET.get(r2Key);
  if (!obj) throw new Error(`Font not found in R2: ${r2Key}`);
  const data = arrayBufferToBase64(await obj.arrayBuffer());
  fontB64Cache.set(r2Key, { data, fetched_at: Date.now() });
  return data;
}

// ---------- Cutout URL validation ----------

// Returns a warning string if the URL is unreachable, null if OK.
async function checkCutoutUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
    if (!res.ok) return `cutout image was unreachable: ${url} (HTTP ${res.status})`;
    return null;
  } catch {
    return `cutout image was unreachable: ${url}`;
  }
}

// ---------- Browser Rendering ----------

async function renderToPng(env: Env, req: RenderRequest): Promise<Uint8Array> {
  const [templateHtml, font400, font500, font600, font700, font800, font900] = await Promise.all([
    fetchTemplate(env, req.template, req.variant),
    fetchFontBase64(env, 'templates/cards/_shared/fonts/barlow-condensed-400.woff2'),
    fetchFontBase64(env, 'templates/cards/_shared/fonts/barlow-condensed-500.woff2'),
    fetchFontBase64(env, 'templates/cards/_shared/fonts/barlow-condensed-600.woff2'),
    fetchFontBase64(env, 'templates/cards/_shared/fonts/barlow-condensed-700.woff2'),
    fetchFontBase64(env, 'templates/cards/_shared/fonts/barlow-condensed-800.woff2'),
    fetchFontBase64(env, 'templates/cards/_shared/fonts/barlow-condensed-900.woff2'),
  ]);

  const vars = buildTemplateVars(req);
  let finalHtml = renderTemplate(templateHtml, vars);

  // Inline @font-face with base64 data URIs so Puppeteer never needs a
  // separate network request for fonts — eliminates CORS/timing issues.
  // JetBrains Mono is intentionally excluded; templates fall back to ui-monospace.
  const inlineFonts = `<style>
@font-face{font-family:'Barlow Condensed';font-weight:400;font-style:normal;font-display:block;src:url('data:font/woff2;base64,${font400}')format('woff2')}
@font-face{font-family:'Barlow Condensed';font-weight:500;font-style:normal;font-display:block;src:url('data:font/woff2;base64,${font500}')format('woff2')}
@font-face{font-family:'Barlow Condensed';font-weight:600;font-style:normal;font-display:block;src:url('data:font/woff2;base64,${font600}')format('woff2')}
@font-face{font-family:'Barlow Condensed';font-weight:700;font-style:normal;font-display:block;src:url('data:font/woff2;base64,${font700}')format('woff2')}
@font-face{font-family:'Barlow Condensed';font-weight:800;font-style:normal;font-display:block;src:url('data:font/woff2;base64,${font800}')format('woff2')}
@font-face{font-family:'Barlow Condensed';font-weight:900;font-style:normal;font-display:block;src:url('data:font/woff2;base64,${font900}')format('woff2')}
</style>`;
  finalHtml = finalHtml.replace('</head>', inlineFonts + '</head>');

  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 1 });
    await page.setContent(finalHtml, { waitUntil: 'networkidle0', timeout: 15000 });
    await page.evaluate(async () => {
      const d = (globalThis as any).document;
      await Promise.all([
        d.fonts.load('400 32px "Barlow Condensed"'),
        d.fonts.load('500 32px "Barlow Condensed"'),
        d.fonts.load('600 32px "Barlow Condensed"'),
        d.fonts.load('700 280px "Barlow Condensed"'),
        d.fonts.load('800 244px "Barlow Condensed"'),
        d.fonts.load('900 32px "Barlow Condensed"'),
      ]);
      await d.fonts.ready;
    });
    const screenshot = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: 1080, height: 1080 },
      omitBackground: false,
    });
    return screenshot as Uint8Array;
  } finally {
    await browser.close();
  }
}

// ---------- Main render handler ----------

export async function handleRender(request: Request, env: Env, authContext: AuthContext): Promise<Response> {
  // D07 commit 7: role gate — compose flow restricted to admin/coach/social
  if (!COMPOSE_RENDER_ROLES.has(authContext.role)) {
    return errorResponse(403, 'Forbidden — role not authorized to render cards', env);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON', env);
  }

  const validation = validateRenderRequest(body);
  if (!validation.ok) {
    return errorResponse(400, validation.error, env);
  }
  const req = validation.data;

  // D07 commit 7: team gate — non-admins can only render for teams in their scope
  if (!authContext.isAdmin && !authContext.teams.includes(req.team_id)) {
    return errorResponse(403, `Forbidden — team ${req.team_id} not in caller scope`, env);
  }

  const callerEmail = authContext.email;
  const contentHash = await computeContentHash(req);

  // Cache lookup by content hash
  const cached = await env.DB.prepare(
    `SELECT id, r2_key FROM generated_cards WHERE content_hash = ? AND deleted_at IS NULL LIMIT 1`
  ).bind(contentHash).first<{ id: number; r2_key: string }>();

  if (cached) {
    return jsonResponse({
      url: `https://cards.canonniersdequebec.ca/${cached.r2_key}`,
      cached: true,
      card_id: cached.id,
      render_ms: null,
    }, env);
  }

  // Pre-check cutout URLs; omit unreachable ones and surface warnings rather
  // than letting the browser hang on a failed image load.
  const warnings: string[] = [];
  let renderReq = req;
  const cutouts = req.content.cutouts ?? [];
  if (cutouts.length > 0) {
    const checks = await Promise.all(cutouts.map((co) => checkCutoutUrl(co.image_url)));
    const failWarnings = checks.filter((w): w is string => w !== null);
    warnings.push(...failWarnings);
    if (failWarnings.length > 0) {
      renderReq = { ...req, content: { ...req.content, cutouts: cutouts.filter((_, i) => checks[i] === null) } };
    }
  }

  // Cache miss — render
  const startedAt = Date.now();
  let pngData: Uint8Array;
  try {
    pngData = await renderToPng(env, renderReq);
  } catch (err) {
    console.error('Render failed', { contentHash, err: String(err) });
    return errorResponse(500, 'Render failed', env);
  }
  const renderMs = Date.now() - startedAt;

  // Upload to R2
  const r2Key = `generated/${req.template}/${req.variant}/${contentHash.slice(0, 16)}.png`;
  await env.CARDS_BUCKET.put(r2Key, pngData, {
    httpMetadata: { contentType: 'image/png' },
  });

  // Insert cache row — maps to actual generated_cards schema
  const insertResult = await env.DB.prepare(`
    INSERT INTO generated_cards
      (content_hash, template, size_variant, team_id, game_id, lang, season,
       r2_key, created_by, created_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    contentHash,
    req.template,
    req.variant,
    req.team_id,
    req.game_id ?? null,
    req.content.language,
    req.content.game_date?.slice(0, 4) ?? null,
    r2Key,
    callerEmail,
    Math.floor(Date.now() / 1000),
    JSON.stringify({ render_ms: renderMs, payload: req }),
  ).run();

  return jsonResponse({
    url: `https://cards.canonniersdequebec.ca/${r2Key}`,
    cached: false,
    card_id: insertResult.meta.last_row_id,
    render_ms: renderMs,
    ...(warnings.length > 0 ? { warnings } : {}),
  }, env);
}
