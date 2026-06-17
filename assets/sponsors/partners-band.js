/* ==========================================================================
   Canonniers de Québec — Footer "Team Partners" band (Placement 3)
   Self-contained: include AFTER sponsors.js on any public page and it injects
   a compact partners strip directly above <footer>. Omits itself when the
   resolved team has no sponsors, and on the Partners page itself.
   ==========================================================================*/
(function () {
  if (!window.CDQ || !window.CDQ_SPONSORS) return;

  // Don't show the band on the Partners page (it IS the full directory).
  var path = (location.pathname || "").toLowerCase();
  if (path.indexOf("partenaires") !== -1) return;

  var TEAM_LABELS = { u15: "15U AAA", u17d1: "17U D1", u17d2: "17U D2" };

  // Which team is this page about? Follow the site-wide selection, default u15.
  var team = localStorage.getItem("activeTeam");
  if (!TEAM_LABELS[team]) team = "u15";

  var list = window.CDQ.teamSponsors(team);
  if (!list.length) return;                 // no sponsors → no band

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

  var label = TEAM_LABELS[team];
  var logos = list.slice(0, 8).map(window.CDQ.wellHTML).join("");

  var band = document.createElement("section");
  band.className = "partners-band";
  band.innerHTML =
    '<div class="pb-inner">' +
      '<div class="pb-eyebrow">' +
        '<span class="fr-text">Partenaires de l\'équipe</span>' +
        '<span class="en-text">Team partners</span> <b>· ' + window.CDQ.esc(label) + '</b>' +
      '</div>' +
      '<div class="pb-logos">' + logos + '</div>' +
      '<a class="pb-link" href="partenaires.html">' +
        '<span class="fr-text">Voir tous nos partenaires</span>' +
        '<span class="en-text">See all our partners</span> →</a>' +
    '</div>';

  footer.parentNode.insertBefore(band, footer);
})();
