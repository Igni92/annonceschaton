// Zone géographique et sélection des annonces (chatons / nouveaux arrivants).
import { departementCentre, departementsAutour, haversineKm, normalizeDepartement, resolveCentre } from './geo.js';
import { firstSeen } from './state.js';
import { addDaysIso, localIsoDate } from './dates.js';

/**
 * Construit l'objet zone utilisé par les sources et les filtres.
 * @returns {Promise<{mode:string, centre:object|null, rayon_km:number, departements:string[], marge_departement_km:number, label:string, inZone:Function}>}
 */
export async function buildZone(config, http = null, log = () => {}) {
  const z = config.zone;
  const marge = Number(z.marge_departement_km ?? 25);
  let centre = null;
  let label = 'France entière';
  let departements = [];

  if (z.mode === 'rayon') {
    centre = await resolveCentre(z.centre ?? {}, http, log);
    label = `${z.rayon_km} km autour de ${centre.label}`;
    log(`Zone : ${label} (${centre.latitude.toFixed(4)}, ${centre.longitude.toFixed(4)} — via ${centre.methode}).`);
  } else if (z.mode === 'departements') {
    departements = (z.departements ?? []).map(normalizeDepartement).filter(Boolean);
    label = `départements ${departements.join(', ')}`;
    log(`Zone : ${label}.`);
    // Centre indicatif (pour trier par distance) : préfecture du premier département.
    centre = departementCentre(departements[0]) ?? null;
  } else {
    log('Zone : France entière (aucun filtre géographique).');
  }

  // Départements acceptés pour les annonces sans coordonnées précises (mode rayon : chefs-lieux à portée).
  const departementsAcceptes = new Set(
    z.mode === 'rayon' && centre ? departementsAutour(centre, Number(z.rayon_km ?? 0), marge) : departements,
  );

  const zone = {
    mode: z.mode, centre, rayon_km: Number(z.rayon_km ?? 0), departements, marge_departement_km: marge, label,
    departements_acceptes: [...departementsAcceptes].sort(),
    /** Vrai si l'annonce est dans la zone. */
    inZone(listing) {
      const lieu = listing?.lieu ?? {};
      if (z.mode === 'france') return true;
      const deps = new Set([lieu.departement, ...(lieu.departements_adoption ?? [])].filter(Boolean));
      if (z.mode === 'departements') return [...deps].some((d) => departements.includes(d));
      // mode rayon
      if (lieu.latitude == null || lieu.longitude == null || lieu.precision === 'departement' || !centre) {
        // Pas de coordonnées fiables : on accepte si l'un des départements est à portée du centre.
        return [...deps].some((d) => departementsAcceptes.has(d));
      }
      const d = lieu.distance_km ?? haversineKm(centre, lieu);
      return d != null && d <= zone.rayon_km;
    },
  };
  return zone;
}

/** Chatons : âge connu et strictement inférieur à age_max_mois. */
export function selectKittens(listings, config) {
  const max = Number(config.age_max_mois);
  return listings
    .filter((l) => l.age_mois != null && l.age_mois < max)
    .filter((l) => config.inclure_reserves || !l.reserve)
    .sort(byDistanceThenAge);
}

/**
 * Nouveaux arrivants selon le critère configuré :
 *  - date_publication : mis en ligne depuis N jours au plus, en jours civils (jours = 1 → aujourd'hui et hier)
 *  - premiere_vue     : jamais vu par le bot avant cette exécution (`fresh` = ids nouveaux)
 *  - les_deux         : l'un OU l'autre
 */
export function selectNewcomers(listings, config, { state, fresh = new Set(), now = new Date() } = {}) {
  const { jours, critere, tous_ages } = config.nouveaux_arrivants;
  const fuseau = config.planification?.fuseau ?? 'Europe/Paris';
  const cutoff = addDaysIso(localIsoDate(now, fuseau), -Number(jours)); // date civile la plus ancienne acceptée
  const recentByDate = (l) => typeof l.date_publication === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(l.date_publication) && l.date_publication >= cutoff;
  const neverSeen = (l) => fresh.has(l.id) || (state && firstSeen(state, l.id) == null);
  const isNew = (l) => {
    if (critere === 'date_publication') return recentByDate(l);
    if (critere === 'premiere_vue') return neverSeen(l);
    return recentByDate(l) || neverSeen(l);
  };
  return listings
    .filter(isNew)
    .filter((l) => tous_ages !== false || (l.age_mois != null && l.age_mois < Number(config.age_max_mois)))
    .filter((l) => config.inclure_reserves || !l.reserve)
    .sort(byDateThenDistance);
}

function byDistanceThenAge(a, b) {
  const da = a.lieu?.distance_km ?? Infinity, db = b.lieu?.distance_km ?? Infinity;
  if (da !== db) return da - db;
  return (a.age_mois ?? Infinity) - (b.age_mois ?? Infinity);
}

function byDateThenDistance(a, b) {
  const ta = a.date_publication ?? '', tb = b.date_publication ?? '';
  if (ta !== tb) return tb.localeCompare(ta); // plus récent d'abord
  return byDistanceThenAge(a, b);
}

/** Supprime les doublons d'identifiant en conservant la première occurrence. */
export function dedupe(listings) {
  const seen = new Set();
  return listings.filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)));
}
