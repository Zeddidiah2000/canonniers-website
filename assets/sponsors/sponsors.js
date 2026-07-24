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
      { name: "Les Voyages Simon Pelletier", logo: "assets/sponsors/lvsp.jpg?v=2",          url: "https://lesvoyagessimonpelletier.com/" },
      { name: "Maxi-Forme",                  logo: "assets/sponsors/maxi-forme.png?v=2",     url: "https://www.maxiforme.com/" },
      { name: "Mercure Assurance",           logo: "assets/sponsors/mercure-assurance.png", url: "https://mercureassurance.com/" },
      { name: "CJS Mécanique",               logo: "assets/sponsors/cjs-mecanique.jpg?v=2", url: "https://cjsmecanique.com/" },
      { name: "Mode Choc",                   logo: "assets/sponsors/mode-choc.png",         url: "https://www.modechoc.ca/" },
      { name: "Eastern Québec Learning Centre", logo: "assets/sponsors/eastern-quebec.svg", url: "https://easternquebec.ca/" },
      // No logo / no website yet — faux well until assets arrive.
      { name: "Ferme Marcel Nadeau et frères", shape: "shape-rounded", url: null },
      // No website — link the Facebook page.
      { name: "Les Voyages du Méridien",       logo: "assets/sponsors/meridien.jpg?v=2", url: "https://www.facebook.com/voyagekarinefontaine" },
      { name: "Tomas Tam",                     logo: "assets/sponsors/tomas-tam.jpg",     url: "https://tomastam.com/" }
    ],
    silver: [
      { name: "Univers Traction Sports", logo: "assets/sponsors/univers-traction.png?v=2", url: "https://argoquebec.com/" }
    ],
    bronze: []
    // Removed sponsors are archived in docs/archived-sponsors.md (restorable).
  },

  // 17U sponsors (2026-07-09). No tiers were provided → all treated as gold
  // (equal rotation). url:null = business identified but no verified site/FB.
  u17d1: {
    gold: [
      { name: "Blanchette Centre Dentaire", logo: "assets/sponsors/blanchette-centre-dentaire.png", url: "https://centredentaireblanchette.ca/" },
      { name: "Teknion",                    logo: "assets/sponsors/teknion.png",             url: "https://www.teknion.com/can/fr" },
      { name: "TEAM Bâtisseur",             logo: "assets/sponsors/team-batisseur.jpg",      url: "https://teambatisseur.ca/" },
      { name: "Climatisation Déry",         logo: "assets/sponsors/climatisation-dery.png",  url: "https://www.climatisationdery.com/" },
      { name: "Clinique Roy Boivin",        logo: "assets/sponsors/clinique-roy-boivin.jpg", url: "https://cliniqueroyboivin.com/" },
      { name: "ConduiPro",                  logo: "assets/sponsors/conduipro.png",           url: "https://conduipro.com/" },
      { name: "Familiprix Frédéric Dupéré et Andrée Gélinas", logo: "assets/sponsors/familiprix-dupere-gelinas.png", url: "https://www.familiprix.com/fr/pharmacies/frederic-dupere-et-andree-gelinas-4b62ac2a-abb0-4b58-9823-b76d90077f0e" },
      { name: "Gaévan",                     logo: "assets/sponsors/gaevan.jpg",              url: "https://www.gaevan.com/" },
      { name: "Les Carrossiers du Port",    logo: "assets/sponsors/carrossiers-du-port.jpg", url: "http://www.lescarrossiersduport.com/" },
      { name: "RigCraftor",                 logo: "assets/sponsors/rigcraftor.png",          url: "https://rigcraftor.com/" },
      { name: "Simétal",                    logo: "assets/sponsors/simetal.png",             url: "https://www.simetal.ca/" },
      { name: "Axchem Canada",              logo: "assets/sponsors/axchem.png",              url: "https://www.axchemgroup.com/axchem-in-the-world/axchem-canada/" },
      { name: "Capitale Chrysler",          logo: "assets/sponsors/capitale-chrysler.jpg",   url: "https://www.capitalechrysler.ca/" },
      { name: "Entreprises Jacques Dufour", logo: "assets/sponsors/jacques-dufour.png",      url: "https://entreprisesjacquesdufour.com/" },
      { name: "Déneigement JDB",            logo: "assets/sponsors/deneigement-jdb.jpg",     url: "https://www.deneigementjdb.com/" },
      { name: "Finition Blouin",            logo: "assets/sponsors/finition-blouin.png",     url: "https://finitionblouin.com/" },
      { name: "QC Contrôle",                logo: "assets/sponsors/qc-controle.png",         url: "https://qccontrole.ca/" },
      { name: "Usinage Rafinex",            logo: "assets/sponsors/rafinex.png",             url: null },
      { name: "SA Service Agricole",        logo: "assets/sponsors/sa-service-agricole.png", url: "https://www.saserviceagricole.ca/" },
      { name: "Sigvaris",                   logo: "assets/sponsors/sigvaris.jpg",            url: "https://www.sigvaris.com/fr-ca" },
      { name: "Sustana",                    logo: "assets/sponsors/sustana.png",             url: "https://sustanasolutions.com/" }
    ],
    silver: [],
    bronze: []
  },
  u17d2: {
    gold: [
      { name: "Charles-Auguste Fortier (CAF)",   logo: "assets/sponsors/caf-fortier.png",                url: "https://excavationcaf.ca/" },
      { name: "Les Constructions Pierre Blouin", logo: "assets/sponsors/construction-pierre-blouin.jpg", url: "https://constructionpierreblouin.com/" },
      { name: "Drolet Construction",             logo: "assets/sponsors/drolet-construction.png",        url: "https://www.droletconstruction.com/" },
      { name: "Fortier Cabinet Conseil",         logo: "assets/sponsors/fortier-cabinet-conseil.png",    url: null },
      { name: "JLM",                             logo: "assets/sponsors/jlm.png",                        url: null },
      { name: "Lauréat Pépin",                   logo: "assets/sponsors/laureat-pepin.jpg",              url: "https://laureatpepin.ca/" },
      { name: "Général Wok",                     logo: "assets/sponsors/general-wok.png",                url: "https://generalwok.ca/" },
      { name: "Sports aux Puces Lévis",          logo: "assets/sponsors/sports-aux-puces-levis.png",     url: "https://www.saplevis.com/" },
      { name: "Marché Pie-XII",                  logo: "assets/sponsors/marche-pie-xii.png",             url: "https://marchepiexii.com/" },
      { name: "Équipe Pelletier-Poiré-Tremblay", logo: "assets/sponsors/equipe-pelletier-poire-tremblay.png", url: "https://www.facebook.com/Equipe.Pelletier.Poire.Tremblay/" },
      { name: "Nomad Télécom",                   logo: "assets/sponsors/nomad-telecom.png",              url: "https://nomadtelecom.ca/" },
      { name: "Réseau Sports Adultes",           logo: "assets/sponsors/reseau-sports-adultes.png",      url: "https://reseausportsadultes.com/" },
      // Provided asset is a promo slide (white-on-dark) — faux well until a clean logo arrives.
      { name: "Maison Adam",                     shape: "shape-rounded",                                 url: "https://maisonadam.ca/" },
      { name: "Sonorisation E2plus",             logo: "assets/sponsors/sonorisation-e2plus.png",        url: "https://www.facebook.com/sonorisatione2plus/" },
      { name: "Ste-Foy Nissan",                  logo: "assets/sponsors/ste-foy-nissan.jpg",             url: "https://www.stefoynissan.com/" },
      { name: "Tanguay",                         logo: "assets/sponsors/tanguay.png",                    url: "https://www.tanguay.ca/" },
      { name: "VitrXpert",                       logo: "assets/sponsors/vitrxpert.jpg",                  url: "https://www.vitrxpert.com/" },
      { name: "GFL Environnement (Green for Life)", logo: "assets/sponsors/gfl-environmental.png",       url: "https://gflenv.com/" }
    ],
    silver: [],
    bronze: []
  },

  /* Elected-official / institutional partners (e.g. députés / Assemblée nationale).
     REGULATORY: these must be described as "partenaires / collaborateurs" only —
     never "commandite/commanditaires/dons/donateurs". They partner with all three
     teams collectively, so they live here rather than under a team key.
     Rendered as a separate "Nos partenaires locaux / Our Local Partners"
     section on the Partners page — never mixed into the business grid, band,
     or presented-by. Each entry shows the official Assemblée nationale card. */
  collective: {
    partners: [
      {
        name: "Mario Asselin",
        role_fr: "Député de Vanier–Les Rivières",
        role_en: "MNA for Vanier–Les Rivières",
        card: "assets/sponsors/depute-mario-asselin.jpg?v=2",
        phone: "418-644-3107",
        email: "Mario.Asselin.VANI@assnat.qc.ca",
        url: null
      },
      {
        name: "Vincent Caron",
        role_fr: "Député de Portneuf",
        role_en: "MNA for Portneuf",
        card: "assets/sponsors/depute-vincent-caron.jpg",
        phone: null, email: null, url: null
      },
      {
        name: "Bernard Drainville",
        role_fr: "Député de Lévis",
        role_en: "MNA for Lévis",
        card: "assets/sponsors/depute-bernard-drainville.jpg",
        phone: null, email: null, url: null
      },
      {
        name: "Geneviève Guilbault",
        role_fr: "Députée de Louis-Hébert",
        role_en: "MNA for Louis-Hébert",
        card: "assets/sponsors/depute-genevieve-guilbault.jpg",
        phone: null, email: null, url: null
      },
      {
        name: "Gabriel Hardy",
        role_fr: "Député de Montmorency–Charlevoix",
        role_en: "MP for Montmorency–Charlevoix",
        card: "assets/sponsors/depute-gabriel-hardy.jpg",
        phone: null, email: null, url: null
      },
      {
        name: "François Jacques",
        role_fr: "Député de Mégantic",
        role_en: "MNA for Mégantic",
        card: "assets/sponsors/depute-francois-jacques.jpg",
        phone: null, email: null, url: null
      },
      {
        name: "Jonatan Julien",
        role_fr: "Député de Charlesbourg",
        role_en: "MNA for Charlesbourg",
        card: "assets/sponsors/depute-jonatan-julien.jpg",
        phone: null, email: null, url: null
      },
      {
        name: "Steeve Lavoie",
        role_fr: "Député de Beauport–Limoilou",
        role_en: "MP for Beauport–Limoilou",
        card: "assets/sponsors/depute-steeve-lavoie.jpg",
        phone: null, email: null, url: null
      },
      {
        name: "Dominique Vien",
        role_fr: "Députée de Bellechasse–Les Etchemins–Lévis",
        role_en: "MP for Bellechasse–Les Etchemins–Lévis",
        card: "assets/sponsors/depute-dominique-vien.jpg",
        phone: null, email: null, url: null
      }
    ]
  }
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
  //   - Any Gold can land in either slot with any partner. (The previous
  //     neighbour-pairing locked sponsors into fixed couples, and on an
  //     EVEN-sized Gold list half the pairs — and the last Gold entirely —
  //     could never appear. Keep slot 2 an independent draw.)
  //   - Every ~4th game the 2nd slot is a Silver sponsor instead of a 2nd Gold.
  //   - gameKey: always build it with presKey() below.
  // mix32: murmur3-style finisher. The raw base-31 rolling hash clusters on
  // structured keys ("u15|2026-07-15|marquis" vs "u15|2026-07-19|phoenix"),
  // which is what made the same pairs repeat game after game — the finisher
  // is load-bearing for rotation fairness, don't remove it.
  function mix32(h) {
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }
  function gameIndex(gameKey) {
    var h = 0, str = String(gameKey == null ? "" : gameKey);
    for (var i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) >>> 0; }
    return mix32(h);
  }
  // Canonical per-game seed shared by EVERY "Presented by" placement so the
  // same game shows the same sponsors across the home card, the diffusion
  // preview, and the in-stream overlay — even though those surfaces are fed by
  // different data systems (GameChanger vs Spordle, with different game ids and
  // name spellings). Keyed on team + ET date + opponent mascot (the same join
  // key the rest of the app uses), so it resolves identically from either
  // source. Doubleheaders (same opponent, same day) intentionally share a pick.
  // Always build the gameKey passed to pickPresenters with this helper.
  function presKey(teamKey, oppName, dateLike) {
    var mascot = String(oppName == null ? "" : oppName)
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().trim().split(/[\s\-]+/)[0] || "";
    var ymd = "";
    if (dateLike) {
      var d = new Date(dateLike);
      if (!isNaN(d.getTime())) {
        ymd = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit"
        }).format(d);
      }
    }
    return teamKey + "|" + ymd + "|" + mascot;
  }
  function pickPresenters(teamKey, gameKey) {
    var t = S[teamKey];
    if (!t) return [];
    var gold = t.gold || [], silver = t.silver || [];
    if (!gold.length) return [];
    var n = gold.length;
    var h = gameIndex(gameKey);
    var h2 = mix32(h ^ 0x9e3779b9); // independent draw for slot 2
    var a = gold[h % n];
    var b;
    if (silver.length && h % 4 === 3) {
      b = silver[h2 % silver.length];
    } else if (n > 1) {
      // uniform over the n-1 other Golds — never equal to slot 1
      b = gold[((h % n) + 1 + (h2 % (n - 1))) % n];
    }
    return (b && b !== a) ? [a, b] : [a];
  }

  // Full per-game rotation order for broadcast surfaces (overlay-broadcast):
  // EVERY sponsor, all tiers, exactly once, deterministically shuffled per
  // game — with the two presented-by picks first, so the burned stream opens
  // on the exact lockup the homepage announced before cycling the whole pool.
  function presRotation(teamKey, gameKey) {
    var pool = teamSponsors(teamKey);
    if (!pool.length) return [];
    var picks = pickPresenters(teamKey, gameKey);
    var rest = pool.filter(function (s) { return picks.indexOf(s) === -1; });
    var seed = gameIndex(gameKey);
    for (var i = rest.length - 1; i > 0; i--) { // seeded Fisher–Yates
      seed = mix32((seed + 0x9e3779b9) >>> 0);
      var j = seed % (i + 1);
      var tmp = rest[i]; rest[i] = rest[j]; rest[j] = tmp;
    }
    return picks.concat(rest);
  }

  window.CDQ = {
    esc: esc,
    teamSponsors: teamSponsors,
    hasSponsors: hasSponsors,
    wellHTML: wellHTML,
    presWellHTML: presWellHTML,
    presKey: presKey,
    pickPresenters: pickPresenters,
    presRotation: presRotation
  };
})();
