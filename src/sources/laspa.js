// Source la-spa.fr — API JSON publique du site (aucun scraping HTML).
// Voir docs/SOURCES.md pour le détail des endpoints.
import { bestAgeInMonths, parseAgeToMonths, parseBirthDate, toIsoDate } from '../age.js';
import { departementFromPostcode, haversineKm, postcodeFromAddress, toCoord } from '../geo.js';
import { normalizeSex, stripTags, truncate } from '../text.js';
import { getCachedFiche, setCachedFiche } from '../state.js';

export const LASPA_BASE = 'https://www.la-spa.fr/app/wp-json/spa/v1';
export const LASPA_SITE = 'https://www.la-spa.fr';
const PAGE_SIZE = 500;   // maximum accepté par l'API
const SEED = 20240101;   // ordre aléatoire seedé : un seed FIXE garantit une pagination sans doublon
const SERVER_RADIUS_KM = 90; // l'API filtre elle-même à ~100 km autour de latitude/longitude

const RESERVED_RE = /r[ée]serv[ée]/i;

/** Extrait le slug d'une URL d'établissement « /etablissement/<slug>/ ». */
function slugFromUrl(url) {
  const m = String(url ?? '').match(/\/etablissement\/([^/]+)\/?/);
  return m ? m[1] : null;
}

/** Ville depuis une adresse « rue<br>CP Ville ». */
function cityFromAddress(address) {
  const s = stripTags(address ?? '');
  const m = s.match(/\b\d{5}\s+([^\n,]+)/);
  return m ? m[1].trim() : null;
}

/**
 * Transforme la réponse de /establishments en Map slug → lieu normalisé.
 * @param {{items: object[]}} json
 */
export function mapEstablishments(json) {
  const map = new Map();
  for (const it of json?.items ?? []) {
    const slug = slugFromUrl(it.url);
    if (!slug) continue;
    const code_postal = postcodeFromAddress(it.address);
    const lat = toCoord(it.latitude), lon = toCoord(it.longitude);
    map.set(slug, {
      id: String(it.ID ?? ''),
      slug,
      nom: it.name ?? slug,
      type: it.filter?.name ?? null,
      adresse: stripTags(it.address ?? '').replace(/\n/g, ', ') || null,
      ville: cityFromAddress(it.address),
      code_postal,
      departement: departementFromPostcode(code_postal),
      latitude: lat != null && lon != null ? lat : null,
      longitude: lat != null && lon != null ? lon : null,
      url: it.url ? `${LASPA_SITE}${it.url}` : null,
      email: it.email ?? null,
      telephone: it.phone ?? null,
    });
  }
  return map;
}

/** Convertit « 2026-08-21 16:02:32 » (heure de Paris) en « 2026-08-21 ». */
function dateOnly(s) {
  const m = String(s ?? '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * Normalise un élément de /animals/search en annonce commune.
 * @param {object} item
 * @param {Map} establishments
 * @param {Date} now
 */
export function mapSearchResult(item, establishments, now = new Date()) {
  const estSlug = item.establishment?.slug ?? null;
  const est = (estSlug && establishments.get(estSlug)) || null;
  const ageText = item.age_number && item.age_number !== 'N/A' ? item.age_number : null;
  const ageMois = parseAgeToMonths(ageText);
  return {
    id: `laspa:${item.ID}`,
    source: 'laspa',
    source_label: 'La SPA',
    source_id: String(item.ID),
    uid: item.uid ?? null,
    nom: String(item.name ?? '').trim(),
    url: item.full_url ?? (item.url ? `${LASPA_SITE}${item.url}` : null),
    image: item.image ?? item.imageWebp ?? null,
    espece: item.species ?? 'chat',
    race: item.races_label || null,
    sexe: normalizeSex(item.sex ?? item.sex_label),
    age_categorie: item.age ?? null,          // junior | adult | senior (classification du site)
    age_texte: ageText,
    age_mois: ageMois,                        // null tant que la fiche n'a pas été lue (chats < 1 an)
    date_naissance: null,
    date_publication: dateOnly(item.created_at),
    reserve: RESERVED_RE.test(item.name ?? ''),
    sos: Boolean(item.sos), fad: Boolean(item.fad),
    lieu: {
      nom: est?.nom ?? item.establishment?.name ?? null,
      slug: estSlug,
      ville: est?.ville ?? null,
      code_postal: est?.code_postal ?? null,
      departement: est?.departement ?? null,
      latitude: est?.latitude ?? null,
      longitude: est?.longitude ?? null,
      precision: est?.latitude != null ? 'exacte' : 'inconnue',
      distance_km: null,
      url: est?.url ?? (item.establishment?.url ? `${LASPA_SITE}${item.establishment.url}` : null),
    },
    description: item.description ? truncate(stripTags(item.description), 400) : null,
    fiche_lue: false,
    _now: now,
  };
}

/**
 * Extrait les informations utiles de la fiche détaillée (/posts/?_uid=animal-<slug>).
 * @returns {{date_naissance: string|null, description: string|null, sexe: string|null, race: string|null,
 *            lieu: {latitude:number|null, longitude:number|null, adresse:string|null}}}
 */
export function parseFiche(json) {
  const infos = json?.content?.infos ?? {};
  const birth = parseBirthDate(infos.birthday);
  const map0 = json?.content?.establishment?.map?.[0] ?? null;
  const lat = toCoord(map0?.latitude), lon = toCoord(map0?.longitude);
  return {
    date_naissance: toIsoDate(birth),
    description: infos.description ? truncate(stripTags(infos.description), 400) : null,
    sexe: normalizeSex(infos.sex),
    race: infos.races?.map((r) => r.name).filter(Boolean).join(', ') || null,
    lieu: {
      latitude: lat != null && lon != null ? lat : null,
      longitude: lat != null && lon != null ? lon : null,
      adresse: map0?.address ? stripTags(map0.address).replace(/\n/g, ', ') : null,
    },
  };
}

/** Applique une fiche (fraîche ou en cache) à une annonce. */
export function applyFiche(listing, fiche, now = new Date()) {
  if (!fiche) return listing;
  const birth = fiche.date_naissance ? parseBirthDate(fiche.date_naissance) : null;
  listing.date_naissance = fiche.date_naissance ?? listing.date_naissance;
  listing.age_mois = bestAgeInMonths({ birthDate: birth, ageText: listing.age_texte }, now);
  listing.description = listing.description ?? fiche.description ?? null;
  listing.sexe = listing.sexe ?? fiche.sexe ?? null;
  listing.race = listing.race ?? fiche.race ?? null;
  if (listing.lieu.latitude == null && fiche.lieu?.latitude != null) {
    listing.lieu.latitude = fiche.lieu.latitude;
    listing.lieu.longitude = fiche.lieu.longitude;
    listing.lieu.precision = 'exacte';
  }
  listing.fiche_lue = true;
  return listing;
}

function buildSearchUrl({ page, species = 'chat', latitude = null, longitude = null }) {
  const p = new URLSearchParams({
    api: '1', species, seed: String(SEED), posts_per_page: String(PAGE_SIZE), paged: String(page),
  });
  if (latitude != null && longitude != null) {
    p.set('latitude', String(latitude));
    p.set('longitude', String(longitude));
  }
  return `${LASPA_BASE}/animals/search/?${p.toString()}`;
}

/**
 * Récupère toutes les annonces de chats de la SPA, complète l'âge des jeunes chats via leur fiche.
 *
 * @param {object} args
 * @param {object} args.http       client créé par createHttp()
 * @param {object} args.config     configuration validée
 * @param {object} args.state      état persistant (cache des fiches)
 * @param {object} args.zone       zone résolue : { mode, centre:{latitude,longitude}, rayon_km, departements, inZone(listing) }
 * @param {Date}   [args.now]
 * @param {Function} [args.log]
 * @returns {Promise<{listings: object[], stats: object}>}
 */
export async function fetchLaSpa({ http, config, state, zone, now = new Date(), log = () => {} }) {
  const stats = { pages: 0, total_site: 0, dans_zone: 0, fiches: 0, fiches_cache: 0, erreurs: 0 };

  const estJson = await http.getJson(`${LASPA_BASE}/establishments/?api=1`);
  const establishments = mapEstablishments(estJson);
  log(`La SPA : ${establishments.size} établissements chargés.`);

  // Filtre serveur (≈100 km) uniquement si notre rayon tient dedans ; sinon on lit tout et on filtre localement.
  const useServerGeo = zone.mode === 'rayon' && zone.rayon_km <= SERVER_RADIUS_KM && zone.centre;
  const geo = useServerGeo ? { latitude: zone.centre.latitude, longitude: zone.centre.longitude } : {};

  const raw = [];
  let page = 1;
  let nbPages = 1;
  do {
    const json = await http.getJson(buildSearchUrl({ page, ...geo }));
    stats.pages += 1;
    nbPages = Number(json?.nb_pages ?? 1) || 1;
    stats.total_site = Number(json?.total ?? raw.length) || 0;
    for (const item of json?.results ?? []) raw.push(item);
    page += 1;
  } while (page <= nbPages && page <= 50);

  const seen = new Set();
  const listings = [];
  for (const item of raw) {
    if (seen.has(item.ID)) continue;
    seen.add(item.ID);
    const l = mapSearchResult(item, establishments, now);
    if (l.lieu.latitude != null && zone.centre) {
      l.lieu.distance_km = haversineKm(zone.centre, l.lieu);
    }
    if (zone.inZone(l)) listings.push(l);
  }
  stats.dans_zone = listings.length;
  log(`La SPA : ${raw.length} chats sur le site, ${listings.length} dans la zone.`);

  // Fiches : seulement pour les chats dont l'âge est inconnu et classés « junior » (< 1 an) — les seuls
  // susceptibles d'avoir moins de age_max_mois. (Les adultes « N/A » n'ont pas de date de naissance.)
  const needFiche = listings.filter((l) => l.age_mois == null && l.age_categorie === 'junior' && l.uid);
  await Promise.all(needFiche.map(async (l) => {
    const cached = getCachedFiche(state, l.id);
    if (cached) {
      stats.fiches_cache += 1;
      applyFiche(l, cached, now);
      return;
    }
    try {
      const json = await http.getJson(`${LASPA_BASE}/posts/?api=1&_uid=${encodeURIComponent(l.uid)}`);
      const fiche = parseFiche(json);
      stats.fiches += 1;
      setCachedFiche(state, l.id, fiche, now);
      applyFiche(l, fiche, now);
    } catch (err) {
      stats.erreurs += 1;
      log(`La SPA : fiche ${l.uid} illisible (${err.message}).`);
    }
  }));
  if (needFiche.length) log(`La SPA : ${stats.fiches} fiches lues, ${stats.fiches_cache} depuis le cache.`);

  for (const l of listings) delete l._now;
  return { listings, stats };
}
