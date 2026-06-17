/* ==========================================================================
   Canonniers de Québec — Sponsors / Commanditaires
   ONE shared data source + render helpers for all three placements:
     1. Partners page   (partenaires.html)
     2. Presented-by    (index.html game cards + diffusion.html)
     3. Footer band      (partners-band.js, every page)
   Edit the data below to add/remove sponsors — no code changes needed.
   ==========================================================================

   Sponsor shape:
     name   (required) — used as alt text and as the faux-well label
     logo   (optional) — path to logo image; omit for a faux (text) well
     url    (optional) — link target; omit/null for a non-clickable well
     shape  (optional) — faux-well glyph shape when there is no logo
                         (shape-circle | shape-rounded | shape-square |
                          shape-diamond | shape-hex | shape-tri)

   Tiers (gold/silver/bronze) are kept in the data so the "Presented by"
   rotation can weight Gold above Silver. The Partners page renders all
   tiers together in one uniform grid (Jay's call, 2026-06-17). */

window.CDQ_SPONSORS = {
  u15: {
    gold: [
      { name: "Les Voyages Simon Pelletier", logo: "assets/sponsors/lvsp.jpg",             url: "https://lesvoyagessimonpelletier.com/" },
      { name: "Maxi-Forme",                  logo: "assets/sponsors/maxi-forme.png",        url: "https://www.maxiforme.com/" },
      { name: "Mercure Assurance",           logo: "assets/sponsors/mercure-assurance.png", url: "https://mercureassurance.com/" },
      { name: "CJS Mécanique",               logo: "assets/sponsors/cjs-mecanique.jpg?v=2", url: "https://cjsmecanique.com/" },
      { name: "Mode Choc",                   logo: "assets/sponsors/mode-choc.png",         url: "https://www.modechoc.ca/" },
      // No logo / no website yet — faux well until assets arrive.
      { name: "Ferme Marcel Nadeau et frères", shape: "shape-rounded", url: null },
      // Jay: leave as text (no logo) and unlinked until the real site + logo arrive.
      { name: "Les Voyages du Méridien",       shape: "shape-circle",  url: null }
    ],
    silver: [
      { name: "Univers Traction Sports", logo: "assets/sponsors/univers-traction.png", url: "https://argoquebec.com/" }
    ],
    bronze: [
      // No logo (Jay: don't chase it) — faux well.
      { name: "Soucy Aquatik", shape: "shape-tri", url: "https://soucyaquatik.com/fr/" }
    ]
  },

  // No sponsors signed yet — placements omit themselves for these teams.
  u17d1: { gold: [], silver: [], bronze: [] },
  u17d2: { gold: [], silver: [], bronze: [] },

  /* Elected-official / institutional partners (e.g. députés / Assemblée nationale).
     REGULATORY: these must be described as "partenaires / collaborateurs" only —
     never "commandite/commanditaires/dons/donateurs". They partner with all three
     teams collectively, so they live here rather than under a team key.
     RESERVED — populated later via the dedicated MP plan. */
  collective: { partners: [] }
};

/* -------------------------------------------------------------------------- */
/* Shared render + selection helpers (so every placement stays consistent).   */
/* -------------------------------------------------------------------------- */
(function () {
  var S = window.CDQ_SPONSORS;

  function esc(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Flat list of a team's sponsors, Gold → Silver → Bronze.
  function teamSponsors(teamKey) {
    var t = S[teamKey];
    if (!t) return [];
    return (t.gold || []).concat(t.silver || []).concat(t.bronze || []);
  }

  function hasSponsors(teamKey) { return teamSponsors(teamKey).length > 0; }

  // One white logo well. opts.label/labelEn = bilingual aria fallback (unused here).
  function wellHTML(s) {
    var inner = s.logo
      ? '<img src="' + esc(s.logo) + '" alt="' + esc(s.name) + '">'
      : '<span class="faux"><span class="faux-name">' + esc(s.name) + '</span></span>';
    if (s.url) {
      return '<a class="well" href="' + esc(s.url) + '" target="_blank" rel="noopener" ' +
        'aria-label="' + esc(s.name) + '">' + inner + '</a>';
    }
    return '<div class="well" role="img" aria-label="' + esc(s.name) + '">' + inner + '</div>';
  }

  // Compact lockup well for the "Presented by" placement (logo or faux row).
  // Rendered as a non-link span so it can live inside a clickable game card
  // without nesting <a> inside <a>.
  function presWellHTML(s) {
    var inner = s.logo
      ? '<img src="' + esc(s.logo) + '" alt="' + esc(s.name) + '">'
      : '<span class="faux"><span class="faux-name">' + esc(s.name) + '</span></span>';
    return '<span class="pres-well" title="' + esc(s.name) + '">' + inner + '</span>';
  }

  // Deterministic per-game presenter pick.
  //   - 2 logos per game, never 1 (unless the team has a single sponsor).
  //   - Both slots rotate fairly through Gold.
  //   - Every 4th game the 2nd slot is a Silver sponsor instead of a 2nd Gold.
  //   - gameKey: any stable per-game string (game id, date, etc.).
  function gameIndex(gameKey) {
    var h = 0, str = String(gameKey == null ? "" : gameKey);
    for (var i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) >>> 0; }
    return h;
  }
  function pickPresenters(teamKey, gameKey) {
    var t = S[teamKey];
    if (!t) return [];
    var gold = t.gold || [], silver = t.silver || [];
    if (!gold.length) return [];
    var i = gameIndex(gameKey);
    var a = gold[(2 * i) % gold.length];
    var b;
    if (silver.length && (i % 4 === 3)) {
      b = silver[Math.floor(i / 4) % silver.length];
    } else if (gold.length > 1) {
      b = gold[(2 * i + 1) % gold.length];
    }
    return (b && b !== a) ? [a, b] : [a];
  }

  window.CDQ = {
    esc: esc,
    teamSponsors: teamSponsors,
    hasSponsors: hasSponsors,
    wellHTML: wellHTML,
    presWellHTML: presWellHTML,
    pickPresenters: pickPresenters
  };
})();
