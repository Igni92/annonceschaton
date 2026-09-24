// Détection des portées (frères et sœurs) parmi les annonces.
//
// Indices utilisés, du plus sûr au plus faible :
//  1. même lieu (refuge / association) et même date de naissance (à `tolerance_jours` près) ;
//  2. le nom d'une autre annonce du même lieu apparaît dans la description (« sa sœur Mia ») ;
//  3. même lieu, même âge affiché et même date de mise en ligne (annonces sans date de naissance) → « probable » ;
//  4. une annonce à plusieurs noms (« Dean et Gareth ») compte pour plusieurs chatons.
// Le vocabulaire de fratrie (« fratrie », « frère », « sœur », « portée ») est relevé comme indice supplémentaire.
import { normalize } from './text.js';

const MS_PER_DAY = 86_400_000;
const FRATRIE_RE = /\b(fratrie|fr[eè]res?|s(?:oe|œ|o)urs?|port[ée]e|jumeaux|jumelles|inseparables|ins[ée]parables|adopt[ée]s? (?:ensemble|[àa] deux|par deux)|en duo|le duo|les deux ensemble)\b/i;
const MOTS_VIDES = new Set(['chat', 'chaton', 'chatte', 'chatons', 'chattes', 'chatonne', 'adoption', 'sos', 'urgent', 'reserve', 'reservee', 'reserves', 'male', 'femelle', 'petit', 'petite', 'mini', 'bebe', 'bebes', 'les', 'des', 'une', 'the']);

/** « Dean et Gareth » → ['Dean', 'Gareth'] ; « Kusmi, Dumbo et Galanga » → 3 noms ; « Bulle » → ['Bulle']. */
export function splitNames(nom) {
  const base = String(nom ?? '')
    .replace(/\(.*?\)|\[.*?\]|\([^)]*$/g, ' ')          // « (réservée) », « [chaton] », parenthèse tronquée
    .replace(/\b(?:pab|cha|c)\s*\d{3,}\b/gi, ' ')       // références de refuge « PAB29240 »
    .replace(/\s+(?:en accueil|en famille|en fa|[aà] adopter|adoptable|adoption|visible|dispo|disponible|r[ée]serv[ée]e?|urgent|sos)(?=\s|$).*$/i, ' ')
    .replace(/[–—-]\s*(?:adoption\s+)?sos\b.*$/i, ' ')
    .replace(/(\.{3}|…)\s*$/, ' ')
    .replace(/[\s–—\-:;,]+$/, '')
    .trim();
  const parts = base.split(/\s*(?:,|&|\+|\/|\bet\b|\by\b)\s*/i).map((p) => p.trim()).filter(Boolean);
  const names = parts.filter((p) => /[a-zà-ÿ]/i.test(p) && !MOTS_VIDES.has(normalize(p)));
  return names.length ? names : [base || String(nom ?? '')];
}

/** Nombre d'animaux représentés par une annonce (« X et Y » → 2). Les descriptions « X et sa sœur » comptent 1. */
export function countAnimals(listing) {
  const n = splitNames(listing.nom).length;
  return Math.max(1, Math.min(n, 8));
}

/** « chaton mâle », « petite », « bebe »… : trop générique pour relier deux annonces. */
function isGenericName(name) {
  const words = normalize(name).split(/[^a-z0-9]+/).filter(Boolean);
  return words.length === 0 || words.every((w) => w.length < 3 || MOTS_VIDES.has(w) || /^(mal|male|femelle|noir|noire|blanc|blanche|roux|rousse|gris|grise|tigre|tigree|ecaille|siamois|europeen)$/.test(w));
}

function placeKey(l) {
  const lieu = l.lieu ?? {};
  return `${l.source}|${normalize(lieu.slug ?? lieu.url ?? lieu.nom ?? '?')}`;
}

function dayNumber(iso) {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? Math.round(t / MS_PER_DAY) : null;
}

/** Union-find minimal. */
function makeUnionFind(ids) {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
  return { find, union };
}

/**
 * Regroupe les annonces en portées.
 * @param {object[]} listings   annonces (idéalement des chatons : âge connu < 12 mois)
 * @param {object} [opts]
 * @param {number} [opts.tolerance_jours=3]  écart maximal entre dates de naissance d'une même portée
 * @param {number} [opts.taille_min=2]       nombre minimal de chatons pour parler de portée
 * @returns {{ portees: object[], parId: Map<string, object> }}  portées et index annonce → portée
 */
export function detectLitters(listings, { tolerance_jours = 3, taille_min = 2 } = {}) {
  const items = listings.filter((l) => l && l.id);
  const uf = makeUnionFind(items.map((l) => l.id));
  const indices = new Map(items.map((l) => [l.id, new Set()]));
  const strong = new Set(); // ids reliés par un indice fort

  // Regroupement par lieu.
  const byPlace = new Map();
  for (const l of items) {
    const k = placeKey(l);
    if (!byPlace.has(k)) byPlace.set(k, []);
    byPlace.get(k).push(l);
  }

  for (const group of byPlace.values()) {
    // 1) même date de naissance (± tolérance)
    const dated = group.filter((l) => l.date_naissance && dayNumber(l.date_naissance) != null)
      .sort((a, b) => dayNumber(a.date_naissance) - dayNumber(b.date_naissance));
    for (let i = 1; i < dated.length; i += 1) {
      if (dayNumber(dated[i].date_naissance) - dayNumber(dated[i - 1].date_naissance) <= tolerance_jours) {
        uf.union(dated[i - 1].id, dated[i].id);
        for (const l of [dated[i - 1], dated[i]]) { indices.get(l.id).add('même date de naissance'); strong.add(l.id); }
      }
    }

    // 2) nom d'une autre annonce cité dans la description
    for (const l of group) {
      const desc = normalize(l.description ?? '');
      if (desc.length < 10) continue;
      for (const other of group) {
        if (other.id === l.id) continue;
        for (const name of splitNames(other.nom)) {
          const n = normalize(name);
          if (n.length < 3 || isGenericName(name)) continue;
          if (new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(desc)) {
            uf.union(l.id, other.id);
            indices.get(l.id).add(`« ${name} » cité·e dans la description`);
            indices.get(other.id).add(`cité·e dans la description de « ${splitNames(l.nom)[0]} »`);
            strong.add(l.id); strong.add(other.id);
            break;
          }
        }
      }
    }

    // 2b) même lieu : un prénom commun entre deux annonces (« Baloo et Bianca » / « Baby et Bianca ») → même portée
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i], b = group[j];
        const na = splitNames(a.nom).filter((n) => normalize(n).length >= 3 && !isGenericName(n)).map(normalize);
        const nb = new Set(splitNames(b.nom).filter((n) => normalize(n).length >= 3 && !isGenericName(n)).map(normalize));
        const common = na.filter((n) => nb.has(n));
        if (!common.length || (na.length < 2 && nb.size < 2)) continue; // il faut au moins une annonce groupée
        if (a.age_mois != null && b.age_mois != null && Math.abs(a.age_mois - b.age_mois) > 1.5) continue;
        uf.union(a.id, b.id);
        for (const l of [a, b]) { indices.get(l.id).add(`prénom commun « ${common[0]} »`); strong.add(l.id); }
      }
    }

    // 3) sans date de naissance : même âge affiché et même date de mise en ligne → probable
    const undated = group.filter((l) => !l.date_naissance && l.age_mois != null && l.date_publication);
    const buckets = new Map();
    for (const l of undated) {
      const k = `${Math.floor(l.age_mois)}|${l.date_publication}`;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(l);
    }
    for (const b of buckets.values()) {
      if (b.length < 2) continue;
      for (let i = 1; i < b.length; i += 1) uf.union(b[0].id, b[i].id);
      for (const l of b) indices.get(l.id).add('même âge et même date de mise en ligne');
    }
  }

  // 4) vocabulaire de fratrie
  for (const l of items) {
    if (FRATRIE_RE.test(l.description ?? '') || FRATRIE_RE.test(l.nom ?? '')) indices.get(l.id).add('fratrie mentionnée');
  }

  // Fusion entre lieux / sources : une même portée publiée sur deux sites (ex. refuge SPA aussi sur Seconde Chance)
  // partage au moins deux prénoms et un âge proche.
  const nameSets = new Map(items.map((l) => [l.id, new Set(splitNames(l.nom).filter((n) => normalize(n).length >= 3 && !isGenericName(n)).map(normalize))]));
  const roots = () => { const m = new Map(); for (const l of items) { const r = uf.find(l.id); if (!m.has(r)) m.set(r, []); m.get(r).push(l); } return [...m.values()]; };
  const clusterList = roots();
  for (let i = 0; i < clusterList.length; i += 1) {
    for (let j = i + 1; j < clusterList.length; j += 1) {
      const a = clusterList[i], b = clusterList[j];
      if (a[0].source === b[0].source && placeKey(a[0]) === placeKey(b[0])) continue;
      const na = new Set(a.flatMap((l) => [...nameSets.get(l.id)]));
      const nb = new Set(b.flatMap((l) => [...nameSets.get(l.id)]));
      const common = [...na].filter((n) => nb.has(n));
      if (common.length < 2) continue;
      const ageA = a.map((l) => l.age_mois).filter((v) => v != null), ageB = b.map((l) => l.age_mois).filter((v) => v != null);
      if (ageA.length && ageB.length && Math.abs(Math.min(...ageA) - Math.min(...ageB)) > 1.5) continue;
      uf.union(a[0].id, b[0].id);
      for (const l of [...a, ...b]) { indices.get(l.id).add(`même portée publiée sur ${[...new Set([...a, ...b].map((x) => x.source_label ?? x.source))].join(' et ')}`); strong.add(l.id); }
    }
  }

  // Assemblage des portées.
  const clusters = new Map();
  for (const l of items) {
    const root = uf.find(l.id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(l);
  }
  const portees = [];
  const parId = new Map();
  let n = 0;
  for (const membres of clusters.values()) {
    const uniqueNames = (list) => { const seen = new Map(); for (const l of list) for (const n of splitNames(l.nom)) { const k = normalize(n); if (!seen.has(k)) seen.set(k, n); } return [...seen.values()]; };
    const nomsUniques = uniqueNames(membres);
    const sourcesList = [...new Set(membres.map((l) => l.source))];
    const tailleParSource = (src) => { const ms = membres.filter((l) => l.source === src); return Math.max(uniqueNames(ms).length, ms.length); };
    const taille = Math.max(...sourcesList.map(tailleParSource));
    if (taille < taille_min) continue;
    if (membres.length === 1 && countAnimals(membres[0]) < 2) continue;
    n += 1;
    const dates = membres.map((l) => l.date_naissance).filter(Boolean);
    const confiance = membres.length === 1 || membres.some((l) => strong.has(l.id)) ? 'forte' : 'probable';
    const lieu = membres[0].lieu ?? {};
    const portee = {
      id: `portee-${n}`,
      source: membres[0].source,
      source_label: membres[0].source_label ?? membres[0].source,
      lieu: { nom: lieu.nom ?? null, ville: lieu.ville ?? null, departement: lieu.departement ?? null, url: lieu.url ?? null },
      date_naissance: dates.length ? dates.sort()[0] : null,
      age_mois: membres.map((l) => l.age_mois).filter((v) => v != null).sort((a, b) => a - b)[0] ?? null,
      taille,
      annonces: membres.length,
      disponibles: Math.min(taille, Math.max(...sourcesList.map((src) => { const ms = membres.filter((l) => l.source === src && !l.reserve); return Math.max(uniqueNames(ms).length, ms.length); }))),
      confiance,
      indices: [...new Set(membres.flatMap((l) => [...indices.get(l.id)]))],
      membres: membres.map((l) => l.id).sort(),
      noms: nomsUniques.sort((a, b) => a.localeCompare(b, 'fr')),
      sources: [...new Set(membres.map((l) => l.source_label ?? l.source))],
    };
    if (membres.length === 1) portee.indices.unshift(`annonce groupée : ${splitNames(membres[0].nom).join(', ')}`);
    portees.push(portee);
    for (const l of membres) parId.set(l.id, portee);
  }
  portees.sort((a, b) => b.taille - a.taille || (a.age_mois ?? 99) - (b.age_mois ?? 99));
  return { portees, parId };
}

/** Annote chaque annonce avec sa portée (référence légère) et retourne la liste des portées. */
export function annotateLitters(listings, opts = {}) {
  const { portees, parId } = detectLitters(listings, opts);
  for (const l of listings) {
    const p = parId.get(l.id);
    l.portee = p ? { id: p.id, taille: p.taille, disponibles: p.disponibles, confiance: p.confiance, indices: p.indices } : null;
  }
  return portees;
}
