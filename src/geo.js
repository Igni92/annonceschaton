// Géographie : distances, départements, résolution du centre de la zone.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Table { "75": { nom, prefecture, latitude, longitude }, ... } — 101 départements. */
export const DEPARTEMENTS = JSON.parse(
  readFileSync(path.join(HERE, '..', 'data', 'departements.json'), 'utf8'),
);

const EARTH_RADIUS_KM = 6371;

/**
 * Convertit une coordonnée (nombre ou chaîne) en nombre fini, ou null si absente / vide / invalide.
 * Évite le piège Number(null) === 0 qui placerait un point à (0°, 0°).
 */
export function toCoord(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Distance orthodromique (formule de haversine) en kilomètres. */
export function haversineKm(a, b) {
  if (!a || !b) return null;
  const lat1 = toCoord(a.latitude), lon1 = toCoord(a.longitude);
  const lat2 = toCoord(b.latitude), lon2 = toCoord(b.longitude);
  if ([lat1, lon1, lat2, lon2].some((v) => v == null || Math.abs(v) > 360)) return null;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Normalise un code de département : "1" → "01", "2a" → "2A", "971" → "971".
 * @returns {string|null}
 */
export function normalizeDepartement(code) {
  if (code == null) return null;
  const s = String(code).trim().toUpperCase();
  if (/^\d$/.test(s)) return `0${s}`;
  if (/^(\d{2}|\d{3}|2A|2B)$/.test(s)) return s in DEPARTEMENTS ? s : (s.length === 2 || s.length === 3 ? s : null);
  return null;
}

/**
 * Déduit le département d'un code postal : "75011" → "75", "20090" → "2A", "20200" → "2B", "97110" → "971".
 * @returns {string|null}
 */
export function departementFromPostcode(postcode) {
  if (postcode == null) return null;
  const s = String(postcode).trim();
  const m = s.match(/\b(\d{5})\b/);
  if (!m) return null;
  const cp = m[1];
  if (cp.startsWith('97') || cp.startsWith('98')) return cp.slice(0, 3);
  if (cp.startsWith('20')) return Number(cp) < 20200 ? '2A' : '2B';
  return cp.slice(0, 2);
}

/** Extrait le premier code postal à 5 chiffres d'une adresse. */
export function postcodeFromAddress(address) {
  if (address == null) return null;
  const m = String(address).match(/\b(\d{5})\b/);
  return m ? m[1] : null;
}

/** Point { latitude, longitude, label } du chef-lieu d'un département, ou null. */
export function departementCentre(code) {
  const c = normalizeDepartement(code);
  const d = c ? DEPARTEMENTS[c] : null;
  if (!d) return null;
  return { latitude: d.latitude, longitude: d.longitude, label: `${d.prefecture} (${c})`, departement: c };
}

/**
 * Géocode une ville / adresse via api-adresse.data.gouv.fr (gratuit, sans clé).
 * @returns {Promise<{latitude:number, longitude:number, label:string, departement:string|null}|null>}
 */
export async function geocodeAdresse(query, http) {
  if (!query || !http) return null;
  const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(query)}&limit=1`;
  try {
    const json = await http.getJson(url);
    const f = json?.features?.[0];
    const coords = Array.isArray(f?.geometry?.coordinates) ? f.geometry.coordinates : null;
    const lon = toCoord(coords?.[0]), lat = toCoord(coords?.[1]);
    if (lat == null || lon == null) return null;
    const props = f.properties ?? {};
    return {
      latitude: lat,
      longitude: lon,
      label: props.label ?? query,
      departement: departementFromPostcode(props.postcode) ?? (props.context ? normalizeDepartement(String(props.context).split(',')[0]) : null),
    };
  } catch {
    return null;
  }
}

/**
 * Résout le centre de la zone à partir de la configuration :
 *   1. latitude/longitude explicites ;
 *   2. ville (géocodage en ligne, si `http` fourni) ;
 *   3. code_postal → chef-lieu du département.
 * @returns {Promise<{latitude:number, longitude:number, label:string, departement:string|null, methode:string}>}
 */
export async function resolveCentre(centre = {}, http = null, log = () => {}) {
  const lat = toCoord(centre.latitude), lon = toCoord(centre.longitude);
  if (lat != null && lon != null) {
    return {
      latitude: lat, longitude: lon,
      label: centre.ville || centre.code_postal || `${lat},${lon}`,
      departement: departementFromPostcode(centre.code_postal),
      methode: 'coordonnees',
    };
  }
  if (centre.ville) {
    const q = centre.code_postal ? `${centre.code_postal} ${centre.ville}` : centre.ville;
    const geo = await geocodeAdresse(q, http);
    if (geo) return { ...geo, methode: 'geocodage' };
    log(`Géocodage de « ${q} » impossible, repli sur le code postal.`);
  }
  if (centre.code_postal) {
    const dep = departementFromPostcode(centre.code_postal);
    const c = departementCentre(dep);
    if (c) return { ...c, methode: 'departement' };
  }
  throw new Error(
    'Impossible de déterminer le centre de la zone : indiquez zone.centre.latitude/longitude, '
    + 'ou zone.centre.code_postal, ou zone.centre.ville dans config.json.',
  );
}

/**
 * Départements dont le chef-lieu se trouve à moins de `rayonKm + marge` du centre.
 * Sert à limiter les requêtes vers les sites qui ne filtrent que par département.
 */
export function departementsAutour(centre, rayonKm, margeKm = 80) {
  const out = [];
  for (const [code, d] of Object.entries(DEPARTEMENTS)) {
    const dist = haversineKm(centre, d);
    if (dist != null && dist <= rayonKm + margeKm) out.push(code);
  }
  if (centre?.departement && !out.includes(centre.departement)) out.push(centre.departement);
  return out.sort();
}
