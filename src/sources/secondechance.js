// Source secondechance.org — pages HTML rendues côté serveur (scraping léger par expressions régulières).
// Voir docs/SOURCES.md pour la structure des pages.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { bestAgeInMonths, parseAgeToMonths, parseBirthDate, toIsoDate } from '../age.js';
import { departementFromPostcode, departementsAutour, normalizeDepartement } from '../geo.js';
import { decodeEntities, normalizeSex, stripTags, truncate } from '../text.js';
import { getCachedFiche, setCachedFiche } from '../state.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const SC_BASE = 'https://www.secondechance.org';
export const SC_SPECIES_CHAT = 2;
export const SC_AGE_RANGES = { bebe: 1, junior: 2, adulte: 3, senior: 4 }; // Bébé ≈ 0–5 mois, Junior ≈ 6 mois–2 ans
const PAGE_SIZE = 12;

/** Table code département → { id (identifiant interne du site), nom }. */
export const SC_DEPARTEMENTS = JSON.parse(
  readFileSync(path.join(HERE, '..', '..', 'data', 'secondechance_departements.json'), 'utf8'),
);

const RESERVED_RE = /r[ée]serv[ée]/i;

/** Construit l'URL de recherche. `departementId` = identifiant interne (voir SC_DEPARTEMENTS). */
export function buildSearchUrl({ departementId = null, ageRanges = [], page = 1, adoptableOutsideDepartment = false, species = SC_SPECIES_CHAT } = {}) {
  const p = new URLSearchParams();
  p.set('species', String(species));
  if (departementId != null) p.set('department', String(departementId));
  ageRanges.forEach((r, i) => p.set(`ageRanges[${i}]`, String(r)));
  if (adoptableOutsideDepartment) p.set('adoptableOutsideDepartment', '1');
  if (page > 1) p.set('page', String(page));
  return `${SC_BASE}/animal/recherche?${p.toString()}`;
}

/**
 * Analyse une page de résultats.
 * @returns {{ total: number|null, cards: object[] }}
 */
export function parseSearchPage(html) {
  const text = String(html ?? '');
  const totalM = text.match(/(\d+)\s*r[ée]sultats?\s*trouv[ée]s?/i);
  const total = totalM ? Number(totalM[1]) : null;

  // Zone utile : après le compteur de résultats et avant le bloc « Coup de coeur » (cartes promotionnelles).
  let start = totalM ? text.indexOf(totalM[0]) : 0;
  if (start < 0) start = 0;
  let end = text.length;
  for (const marker of ['<!-- Coup de coeur -->', 'Coup de coeur</h2>', 'Coup de coeur ', '<!-- Features pet -->']) {
    const i = text.indexOf(marker, start);
    if (i !== -1 && i < end) end = i;
  }
  const zone = text.slice(start, end);

  const cards = [];
  const cardRe = /<a\s+href="(https?:\/\/www\.secondechance\.org\/animal\/([a-z0-9-]+?)-(\d+))"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = cardRe.exec(zone)) !== null) {
    const [, url, slug, id, inner] = m;
    if (/^(adopter-un|recherche|ils-ont)/.test(slug)) continue;
    const nom = decodeEntities((inner.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    const assocRaw = decodeEntities((inner.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i)?.[1] ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    const infoRaw = decodeEntities((inner.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    const image = inner.match(/<img[^>]+src="([^"]+)"/i)?.[1] ?? null;
    const assocM = assocRaw.match(/^(.*?)\s*\((\d{2,3}|2[AB])\)\s*$/i);
    const association = assocM ? assocM[1].trim() : assocRaw || null;
    const departement = assocM ? normalizeDepartement(assocM[2]) : null;
    // « EUROPÉEN Mâle - 6 mois » | « EUROPÉEN Femelle » | « GERBILLE DE MONGOLIE »
    const infoM = infoRaw.match(/^(.*?)(?:\s+(M[âa]le|Femelle))?(?:\s*-\s*(.+))?$/i);
    const race = infoM?.[1]?.trim() || null;
    const sexe = normalizeSex(infoM?.[2]);
    const ageTexte = infoM?.[3]?.trim() || null;
    const espece = slug.split('-')[0]; // « chat », « chien », « gerbille »…
    cards.push({
      id, url, slug: `${slug}-${id}`, nom, association, departement, race, sexe,
      age_texte: ageTexte, age_mois: parseAgeToMonths(ageTexte), image, espece,
    });
  }
  return { total, cards };
}

/**
 * Analyse une fiche animal.
 */
export function parseFichePage(html) {
  const text = String(html ?? '');
  const attrs = {};
  const attrBlock = text.match(/espece="[^"]*"[^>]*update="[^"]*"/i)?.[0] ?? '';
  for (const [, k, v] of attrBlock.matchAll(/(\w+)="([^"]*)"/g)) attrs[k.toLowerCase()] = decodeEntities(v);

  const birth = parseBirthDate(text.match(/Date de naissance\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i)?.[1]);
  const maj = parseBirthDate(attrs.update ?? '');

  // Description = section « Présentation » jusqu'au bloc « Type : » ou « Date de naissance ».
  let description = null;
  const pres = text.match(/Pr[ée]sentation\s*<\/h2>([\s\S]*?)(?:Type\s*:|Date de naissance|<h2)/i);
  if (pres) description = truncate(stripTags(pres[1]).replace(/\n+/g, ' '), 400) || null;

  // Association : lien /refuge/<dept-slug>/<slug>-<id> + adresse dans le JSON-LD.
  const assocUrl = text.match(/href="(https?:\/\/www\.secondechance\.org\/refuge\/[^"/]+\/[^"]+-\d+)"/i)?.[1] ?? null;
  const postalCode = text.match(/"postalCode"\s*:\s*"(\d{5})"/)?.[1] ?? null;
  const locality = decodeEntities(text.match(/"addressLocality"\s*:\s*"([^"]*)"/)?.[1] ?? '') || null;
  const assocName = decodeEntities(
    text.match(/"@type"\s*:\s*"(?:LocalBusiness|Organization|AnimalShelter)"[\s\S]{0,400}?"name"\s*:\s*"([^"]*)"/)?.[1] ?? '',
  ) || null;

  return {
    date_naissance: toIsoDate(birth),
    date_maj: toIsoDate(maj),
    age_texte: attrs.age ?? null,
    race: attrs.type ?? null,
    sexe: normalizeSex(attrs.sexe),
    couleur: attrs.couleur ?? null,
    pelage: attrs.pelage ?? null,
    taille: attrs.taille ?? null,
    description,
    association: {
      nom: assocName,
      url: assocUrl,
      code_postal: postalCode,
      ville: locality,
      departement: departementFromPostcode(postalCode),
    },
  };
}

/**
 * Transforme une carte en annonce normalisée.
 * Le département affiché sur la carte est celui de la RECHERCHE (l'animal y est adoptable) quand un filtre
 * département est actif ; sans filtre, c'est celui de l'association. On ne dispose pas de coordonnées précises.
 * @param {object} card
 * @param {string|null} departementRecherche  code du département interrogé (null = France entière)
 */
export function mapCard(card, departementRecherche = null, now = new Date()) {
  const depAdoption = departementRecherche ?? card.departement ?? null;
  return {
    id: `secondechance:${card.id}`,
    source: 'secondechance',
    source_label: 'Seconde Chance',
    source_id: String(card.id),
    uid: card.slug,
    nom: card.nom,
    url: card.url,
    image: card.image,
    espece: card.espece,
    race: card.race,
    sexe: card.sexe,
    age_categorie: null,
    age_texte: card.age_texte,
    age_mois: card.age_mois,
    date_naissance: null,
    date_publication: null,
    reserve: RESERVED_RE.test(card.nom ?? ''),
    lieu: {
      nom: card.association,
      slug: null,
      ville: null,
      code_postal: null,
      departement: depAdoption,                 // département où l'animal est adoptable (filtre du site)
      departement_association: departementRecherche ? null : card.departement,
      departements_adoption: new Set([depAdoption].filter(Boolean)),
      latitude: null,
      longitude: null,
      precision: 'departement',
      distance_km: null,
      url: null,
    },
    description: null,
    fiche_lue: false,
  };
}

/** Applique une fiche (fraîche ou en cache) à une annonce. */
export function applyFiche(listing, fiche, now = new Date()) {
  if (!fiche) return listing;
  const birth = fiche.date_naissance ? parseBirthDate(fiche.date_naissance) : null;
  listing.date_naissance = fiche.date_naissance ?? null;
  listing.age_mois = bestAgeInMonths({ birthDate: birth, ageText: listing.age_texte ?? fiche.age_texte }, now);
  listing.age_texte = listing.age_texte ?? fiche.age_texte ?? null;
  listing.date_publication = fiche.date_maj ?? null; // date de mise à jour de la fiche (approximation)
  listing.description = fiche.description ?? listing.description;
  listing.sexe = listing.sexe ?? fiche.sexe ?? null;
  listing.race = listing.race ?? fiche.race ?? null;
  const a = fiche.association ?? {};
  listing.lieu.nom = listing.lieu.nom ?? a.nom ?? null;
  listing.lieu.url = a.url ?? listing.lieu.url;
  listing.lieu.ville = a.ville ?? null;                       // siège de l'association (peut être loin du lieu d'adoption)
  listing.lieu.code_postal = a.code_postal ?? null;
  listing.lieu.departement_association = a.departement ?? listing.lieu.departement_association ?? null;
  if (!listing.lieu.departement && a.departement) listing.lieu.departement = a.departement;
  listing.fiche_lue = true;
  return listing;
}

/** Départements à interroger selon la zone. */
export function departementsPourZone(zone, config) {
  const forced = config?.sources?.secondechance?.departements;
  if (Array.isArray(forced) && forced.length) return forced.map(normalizeDepartement).filter(Boolean);
  if (zone.mode === 'departements') return zone.departements;
  if (zone.mode === 'rayon' && zone.centre) return departementsAutour(zone.centre, zone.rayon_km, zone.marge_departement_km ?? 25);
  return [null]; // france entière : une seule recherche sans département
}

/**
 * Récupère les chatons (tranche « Bébé » [+ « Junior » si nécessaire]) et les annonces récentes.
 * @returns {Promise<{listings: object[], stats: object}>}
 */
export async function fetchSecondeChance({ http, config, state, zone, now = new Date(), log = () => {}, context = {} }) {
  const sc = config.sources.secondechance;
  const stats = { pages: 0, cartes: 0, dans_zone: 0, fiches: 0, fiches_cache: 0, erreurs: 0, departements: 0, pages_tronquees: 0 };
  const pagesMax = Math.max(1, Number(sc.pages_max) || 10);
  const outside = Boolean(sc.adoptable_hors_departement);

  const ranges = [SC_AGE_RANGES.bebe];
  if (config.age_max_mois > 6) ranges.push(SC_AGE_RANGES.junior);
  if (config.age_max_mois > 24) ranges.push(SC_AGE_RANGES.adulte, SC_AGE_RANGES.senior);

  const deps = departementsPourZone(zone, config);
  stats.departements = deps.filter(Boolean).length;
  const byId = new Map();

  const knownIds = new Set(Object.keys(state.vus ?? {}));

  async function crawl({ departement, departementId, ageRanges, stopWhenKnown }) {
    let page = 1;
    let total = null;
    while (page <= pagesMax) {
      const url = buildSearchUrl({ departementId, ageRanges, page, adoptableOutsideDepartment: outside });
      let html;
      try {
        html = await http.getText(url);
      } catch (err) {
        stats.erreurs += 1;
        log(`Seconde Chance : ${url} → ${err.message}`);
        return;
      }
      stats.pages += 1;
      const { total: t, cards } = parseSearchPage(html);
      if (t != null) total = t;
      stats.cartes += cards.length;
      let allKnown = cards.length > 0;
      for (const c of cards) {
        if (c.espece !== 'chat') continue;
        const entry = byId.get(c.id);
        if (!entry) byId.set(c.id, { card: c, departements: new Set(departement ? [departement] : []) });
        else if (departement) entry.departements.add(departement);
        if (!knownIds.has(`secondechance:${c.id}`)) allKnown = false;
      }
      const lastPage = total != null ? Math.ceil(total / PAGE_SIZE) : null;
      if (cards.length === 0 || (lastPage != null && page >= lastPage)) return;
      if (stopWhenKnown && allKnown) return; // les annonces sont triées par date décroissante
      page += 1;
    }
    stats.pages_tronquees += 1;
  }

  for (const dep of deps) {
    const departementId = dep == null ? null : SC_DEPARTEMENTS[dep]?.id ?? null;
    if (dep != null && departementId == null) { log(`Seconde Chance : département ${dep} inconnu du site, ignoré.`); continue; }
    // 1) chatons : toutes les pages (jusqu'à pages_max)
    await crawl({ departement: dep, departementId, ageRanges: ranges, stopWhenKnown: false });
    // 2) nouveaux arrivants (tous âges) : on s'arrête dès qu'une page ne contient que des annonces déjà vues
    if (config.nouveaux_arrivants?.tous_ages !== false) {
      await crawl({ departement: dep, departementId, ageRanges: [], stopWhenKnown: true });
    }
  }

  const listings = [];
  for (const { card, departements } of byId.values()) {
    const first = departements.size ? [...departements][0] : null;
    const l = mapCard(card, first, now);
    for (const d of departements) l.lieu.departements_adoption.add(d);
    if (zone.inZone(l)) listings.push(l);
  }
  stats.dans_zone = listings.length;
  log(`Seconde Chance : ${byId.size} chats trouvés, ${listings.length} dans la zone.`);

  // Fiches : pour les chatons potentiels (âge < max ou inconnu) et les annonces jamais vues.
  // Au premier lancement, tout est « jamais vu » : on se limite aux chatons potentiels pour rester léger.
  if (sc.fiches_details !== false) {
    const isKittenCandidate = (l) => l.age_mois == null || l.age_mois < config.age_max_mois + 1;
    const wanted = listings.filter((l) => isKittenCandidate(l) || (!context.firstRun && !knownIds.has(l.id)));
    await Promise.all(wanted.map(async (l) => {
      const cached = getCachedFiche(state, l.id);
      if (cached) { stats.fiches_cache += 1; applyFiche(l, cached, now); return; }
      try {
        const html = await http.getText(l.url);
        const fiche = parseFichePage(html);
        stats.fiches += 1;
        setCachedFiche(state, l.id, fiche, now);
        applyFiche(l, fiche, now);
      } catch (err) {
        stats.erreurs += 1;
        log(`Seconde Chance : fiche ${l.url} illisible (${err.message}).`);
      }
    }));
    if (wanted.length) log(`Seconde Chance : ${stats.fiches} fiches lues, ${stats.fiches_cache} depuis le cache.`);
  }

  for (const l of listings) l.lieu.departements_adoption = [...l.lieu.departements_adoption].sort();
  return { listings, stats };
}
