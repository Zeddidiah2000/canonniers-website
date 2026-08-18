# Archived sponsors

Sponsors removed from the live site but kept here so they can be restored
verbatim. To re-add, drop the entry back into the matching tier array in
`assets/sponsors/sponsors.js`.

---

## Soucy Aquatik
- **Team:** 15U AAA (`u15`)
- **Tier:** Bronze
- **Removed:** 2026-06-18 (Jay's request — remove completely from the site)
- **Entry:**

```js
// u15.bronze
{ name: "Soucy Aquatik", shape: "shape-tri", url: "https://soucyaquatik.com/fr/" }
```

No logo asset existed (rendered as a faux/text well).

---

## Élus provinciaux (députés de l'Assemblée nationale) — 6 entries

- **Team:** collective (`CDQ_SPONSORS.collective.partners`)
- **Tier:** n/a — "Nos partenaires locaux" section on `partenaires.html`
- **Removed:** 2026-08-17 (Jay's request — provincial election period; only the
  three federal MPs remain live: Gabriel Hardy, Steeve Lavoie, Dominique Vien)
- **Card assets kept on disk** at `assets/sponsors/depute-*.jpg` so restoring is
  a pure data edit — do not delete them.
- **Entries:**

```js
// collective.partners
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
}
```

Insertion order in the original array was: Asselin, Caron, Drainville,
Guilbault, **Hardy**, Jacques, Julien, **Lavoie**, **Vien**.
