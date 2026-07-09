/* ==========================================================================
   Canonniers de Québec — Footer partners band (Placement 3)
   Self-contained: include AFTER sponsors.js on any public page and it injects
   a compact CLUB-WIDE partners strip directly above <footer>. It shows a
   combined mix of every team's sponsors — the footer represents the whole club,
   so it never looks like it belongs to a single team, whatever page you're on.
   (Team-specific sponsor matching lives in the "presented by" lockup + the
   burned broadcast overlay, not here.) Omits itself on the Partners page (which
   is the full directory) and when there are no sponsors anywhere.
   ==========================================================================*/
(function () {
  if (!window.CDQ || !window.CDQ_SPONSORS) return;

  // Don't show the band on the Partners page (it IS the full directory).
  var path = (location.pathname || "").toLowerCase();
  if (path.indexOf("partenaires") !== -1) return;

  var TEAMS = ["u15", "u17d1", "u17d2"];

  // Round-robin across every team that has sponsors (deduped by name), rotating
  // by day so the strip cycles through everyone over time. Capped for space.
  var lists = TEAMS
    .map(function (t) { return window.CDQ.teamSponsors(t); })
    .filter(function (l) { return l.length; });
  if (!lists.length) return;
  var day = Math.floor(Date.now() / 86400000);
  var seen = {}, list = [];
  var maxLen = lists.reduce(function (m, l) { return Math.max(m, l.length); }, 0);
  for (var i = 0; i < maxLen && list.length < 8; i++) {
    for (var t = 0; t < lists.length && list.length < 8; t++) {
      var s = lists[t][(i + day) % lists[t].length];
      if (s && !seen[s.name]) { seen[s.name] = 1; list.push(s); }
    }
  }
  if (!list.length) return;

  var footer = document.querySelector("footer");
  if (!footer) return;

  // ---- styles (scoped under .partners-band; tokens that aren't global are
  //      expanded to literals built from the base palette, present everywhere) ----
  var css = [
    ".partners-band{position:relative;background:linear-gradient(135deg,var(--navy) 0%,var(--navy-mid) 50%,var(--navy-light) 100%);overflow:hidden;padding:26px 24px 28px;border-top:3px solid var(--sky);}",
    ".partners-band::before{content:'';position:absolute;inset:0;background:radial-gradient(circle at 85% 25%,rgba(106,176,212,0.16) 0%,transparent 60%);pointer-events:none;}",
    ".partners-band .pb-inner{max-width:1000px;margin:0 auto;position:relative;text-align:center;}",
    ".partners-band .pb-eyebrow{font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;color:var(--sky-light);margin-bottom:16px;}",
    ".partners-band .pb-eyebrow b{color:#fff;font-weight:700;}",
    ".partners-band .pb-logos{display:flex;flex-wrap:wrap;justify-content:center;gap:12px;}",
    ".partners-band .well{background:#fff;border:1px solid var(--gray-light);border-radius:5px;display:flex;align-items:center;justify-content:center;height:64px;min-width:116px;padding:9px 16px;text-decoration:none;transition:transform 0.18s,box-shadow 0.18s,border-color 0.18s;}",
    ".partners-band a.well{cursor:pointer;}",
    ".partners-band a.well:hover{transform:translateY(-2px);box-shadow:0 6px 24px rgba(13,31,78,0.12);border-color:rgba(106,176,212,0.4);}",
    ".partners-band .well img{max-width:100%;max-height:100%;object-fit:contain;display:block;}",
    ".partners-band .faux{display:flex;align-items:center;justify-content:center;text-align:center;}",
    ".partners-band .faux-name{font-family:'Barlow Condensed',sans-serif;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;color:var(--navy-mid);line-height:1.1;font-size:14px;}",
    ".partners-band .pb-link{display:inline-block;margin-top:18px;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:var(--sky-light);text-decoration:none;border:1.5px solid rgba(106,176,212,0.5);padding:8px 18px;border-radius:3px;transition:all 0.18s;}",
    ".partners-band .pb-link:hover{background:var(--sky);color:var(--navy);border-color:var(--sky);}",
    "@media (max-width:820px){.partners-band{padding:22px 14px;}.partners-band .pb-logos .well{height:58px;min-width:0;flex:1 1 40%;}}"
  ].join("");
  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  var logos = list.slice(0, 8).map(window.CDQ.wellHTML).join("");

  var band = document.createElement("section");
  band.className = "partners-band";
  band.innerHTML =
    '<div class="pb-inner">' +
      '<div class="pb-eyebrow">' +
        '<span class="fr-text">Nos partenaires</span>' +
        '<span class="en-text">Our partners</span>' +
      '</div>' +
      '<div class="pb-logos">' + logos + '</div>' +
      '<a class="pb-link" href="partenaires.html">' +
        '<span class="fr-text">Voir tous nos partenaires</span>' +
        '<span class="en-text">See all our partners</span> →</a>' +
    '</div>';

  footer.parentNode.insertBefore(band, footer);
})();
