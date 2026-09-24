// Chargement, fusion et validation de la configuration.
// Priorité : options de ligne de commande > variables d'environnement > config.json > DEFAULT_CONFIG.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  zone: {
    mode: 'rayon', // 'rayon' | 'departements' | 'france'
    centre: { ville: 'Paris', code_postal: '75011', latitude: null, longitude: null },
    rayon_km: 50,
    departements: ['75', '92', '93', '94'],
    marge_departement_km: 25, // tolérance pour les annonces localisées seulement au département
  },
  age_max_mois: 4,
  nouveaux_arrivants: { jours: 7, critere: 'les_deux', tous_ages: true },
  inclure_reserves: false,
  sources: {
    laspa: { actif: true },
    secondechance: { actif: true, adoptable_hors_departement: false, pages_max: 10, fiches_details: true },
  },
  notifications: {
    console: true,
    fichier: { actif: true, dossier: 'reports' },
    discord: { actif: false, webhook_url: '' },
    telegram: { actif: false, bot_token: '', chat_id: '' },
  },
  planification: { heure: '08:00', fuseau: 'Europe/Paris' },
  http: {
    user_agent: 'annonceschaton-bot/1.0 (+https://github.com/Igni92/annonceschaton)',
    timeout_ms: 30_000,
    tentatives: 3,
    concurrence: 4,
    delai_ms: 250,
  },
  etat: { fichier: 'data/state.json', retention_jours: 90 },
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Fusion récursive : les objets sont fusionnés, les tableaux et scalaires remplacés. */
export function deepMerge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? clone(base) : clone(override);
  const out = isPlainObject(base) ? clone(base) : {};
  for (const [k, v] of Object.entries(override)) {
    if (k === '//') continue; // commentaires dans le JSON
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : clone(v);
  }
  return out;
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** Variables d'environnement reconnues (les secrets n'ont pas à être dans config.json). */
export const ENV_OVERRIDES = {
  DISCORD_WEBHOOK_URL: ['notifications', 'discord', 'webhook_url'],
  TELEGRAM_BOT_TOKEN: ['notifications', 'telegram', 'bot_token'],
  TELEGRAM_CHAT_ID: ['notifications', 'telegram', 'chat_id'],
  ANNONCES_ZONE_MODE: ['zone', 'mode'],
  ANNONCES_VILLE: ['zone', 'centre', 'ville'],
  ANNONCES_CODE_POSTAL: ['zone', 'centre', 'code_postal'],
  ANNONCES_LATITUDE: ['zone', 'centre', 'latitude'],
  ANNONCES_LONGITUDE: ['zone', 'centre', 'longitude'],
  ANNONCES_RAYON_KM: ['zone', 'rayon_km'],
  ANNONCES_DEPARTEMENTS: ['zone', 'departements'],
  ANNONCES_AGE_MAX_MOIS: ['age_max_mois'],
  ANNONCES_NOUVEAUX_JOURS: ['nouveaux_arrivants', 'jours'],
  ANNONCES_STATE_FILE: ['etat', 'fichier'],
  ANNONCES_REPORTS_DIR: ['notifications', 'fichier', 'dossier'],
};

function setPath(obj, keys, value) {
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys.at(-1)] = value;
}

function coerceEnv(keys, raw) {
  const last = keys.at(-1);
  if (last === 'departements') return raw.split(/[,\s;]+/).filter(Boolean);
  if (['latitude', 'longitude', 'rayon_km', 'age_max_mois', 'jours'].includes(last)) {
    const n = Number(raw.replace(',', '.'));
    return Number.isFinite(n) ? n : raw;
  }
  return raw;
}

export function applyEnv(config, env = process.env) {
  const out = clone(config);
  for (const [name, keys] of Object.entries(ENV_OVERRIDES)) {
    const raw = env[name];
    if (raw == null || raw === '') continue;
    setPath(out, keys, coerceEnv(keys, raw));
  }
  // Un centre donné par l'environnement remplace entièrement celui du fichier : pas de mélange « 75011 Lyon ».
  const hasEnv = (k) => env[k] != null && env[k] !== '';
  if (hasEnv('ANNONCES_VILLE') && !hasEnv('ANNONCES_CODE_POSTAL')) out.zone.centre.code_postal = null;
  if (hasEnv('ANNONCES_CODE_POSTAL') && !hasEnv('ANNONCES_VILLE')) out.zone.centre.ville = null;
  if ((hasEnv('ANNONCES_VILLE') || hasEnv('ANNONCES_CODE_POSTAL')) && !hasEnv('ANNONCES_LATITUDE') && !hasEnv('ANNONCES_LONGITUDE')) {
    out.zone.centre.latitude = null;
    out.zone.centre.longitude = null;
  }
  // Active automatiquement les canaux dont les secrets sont fournis par l'environnement.
  if (env.DISCORD_WEBHOOK_URL) out.notifications.discord.actif = true;
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) out.notifications.telegram.actif = true;
  return out;
}

/** Vérifie la cohérence de la configuration ; lève une Error explicite sinon. */
export function validateConfig(c) {
  const errors = [];
  const num = (v) => typeof v === 'number' && Number.isFinite(v);

  if (!['rayon', 'departements', 'france'].includes(c.zone?.mode)) {
    errors.push(`zone.mode doit valoir 'rayon', 'departements' ou 'france' (reçu : ${JSON.stringify(c.zone?.mode)})`);
  }
  if (c.zone?.mode === 'rayon') {
    if (!num(c.zone.rayon_km) || c.zone.rayon_km <= 0) errors.push('zone.rayon_km doit être un nombre > 0');
    if (!num(c.zone.marge_departement_km) || c.zone.marge_departement_km < 0) errors.push('zone.marge_departement_km doit être un nombre ≥ 0');
    const ce = c.zone.centre ?? {};
    const given = (v) => v != null && !(typeof v === 'string' && v.trim() === '');
    const hasCoords = given(ce.latitude) || given(ce.longitude);
    if (hasCoords && (!given(ce.latitude) || !given(ce.longitude) || !num(Number(ce.latitude)) || !num(Number(ce.longitude)))) {
      errors.push('zone.centre.latitude/longitude doivent être des nombres, renseignés ensemble');
    }
    if (!hasCoords && !ce.ville && !ce.code_postal) errors.push('zone.centre : indiquez latitude/longitude, ou ville, ou code_postal');
    if (num(Number(ce.latitude)) && Math.abs(Number(ce.latitude)) > 90) errors.push('zone.centre.latitude doit être comprise entre -90 et 90');
    if (num(Number(ce.longitude)) && Math.abs(Number(ce.longitude)) > 180) errors.push('zone.centre.longitude doit être comprise entre -180 et 180');
    if (ce.code_postal != null && !/^\d{5}$/.test(String(ce.code_postal))) errors.push('zone.centre.code_postal doit comporter 5 chiffres');
  }
  if (c.zone?.mode === 'departements') {
    const deps = c.zone.departements;
    if (!Array.isArray(deps) || deps.length === 0) errors.push('zone.departements doit être une liste non vide, ex. ["75", "92"]');
    else for (const d of deps) if (!/^(\d{1,3}|2[AaBb])$/.test(String(d))) errors.push(`zone.departements : code invalide « ${d} »`);
  }
  if (!num(c.age_max_mois) || c.age_max_mois <= 0) errors.push('age_max_mois doit être un nombre > 0');
  if (!num(c.nouveaux_arrivants?.jours) || c.nouveaux_arrivants.jours < 0) errors.push('nouveaux_arrivants.jours doit être un nombre ≥ 0');
  if (!['date_publication', 'premiere_vue', 'les_deux'].includes(c.nouveaux_arrivants?.critere)) {
    errors.push("nouveaux_arrivants.critere doit valoir 'date_publication', 'premiere_vue' ou 'les_deux'");
  }
  if (!c.sources?.laspa?.actif && !c.sources?.secondechance?.actif) errors.push('Au moins une source doit être active (sources.laspa.actif ou sources.secondechance.actif)');
  if (c.sources?.secondechance?.actif) {
    const pm = c.sources.secondechance.pages_max;
    if (!num(pm) || pm < 1) errors.push('sources.secondechance.pages_max doit être un entier ≥ 1');
  }
  if (c.notifications?.discord?.actif && !c.notifications.discord.webhook_url) errors.push('notifications.discord.webhook_url est requis quand discord.actif = true (ou variable DISCORD_WEBHOOK_URL)');
  if (c.notifications?.telegram?.actif && (!c.notifications.telegram.bot_token || !c.notifications.telegram.chat_id)) {
    errors.push('notifications.telegram.bot_token et chat_id sont requis quand telegram.actif = true (ou variables TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)');
  }
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(c.planification?.heure ?? ''))) errors.push("planification.heure doit être au format HH:MM, ex. '08:00'");
  try { new Intl.DateTimeFormat('fr-FR', { timeZone: c.planification?.fuseau }); } catch { errors.push(`planification.fuseau inconnu : ${c.planification?.fuseau}`); }
  for (const k of ['timeout_ms', 'tentatives', 'concurrence', 'delai_ms']) {
    if (!num(c.http?.[k]) || c.http[k] < 0) errors.push(`http.${k} doit être un nombre ≥ 0`);
  }
  if (errors.length) throw new Error(`Configuration invalide :\n - ${errors.join('\n - ')}`);
  return c;
}

/** Normalisations légères avant validation (codes département, chaînes vides, nombres). */
export function normalizeConfig(c) {
  if (Array.isArray(c.zone?.departements)) {
    c.zone.departements = c.zone.departements.map((d) => {
      const s = String(d).trim().toUpperCase();
      return /^\d$/.test(s) ? `0${s}` : s;
    });
  }
  if (c.zone?.centre) {
    const ce = c.zone.centre;
    const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');
    ce.code_postal = blank(ce.code_postal) ? null : String(ce.code_postal).trim();
    ce.ville = blank(ce.ville) ? null : String(ce.ville).trim();
    ce.latitude = blank(ce.latitude) ? null : Number(String(ce.latitude).replace(',', '.'));
    ce.longitude = blank(ce.longitude) ? null : Number(String(ce.longitude).replace(',', '.'));
  }
  return c;
}

/**
 * Charge la configuration.
 * @param {object} [opts]
 * @param {string} [opts.file]  chemin de config.json (défaut : ./config.json, facultatif)
 * @param {object} [opts.env]
 * @param {object} [opts.overrides]  surcharges programmatiques (ligne de commande)
 */
export function loadConfig({ file = 'config.json', env = process.env, overrides = {}, log = () => {} } = {}) {
  let fromFile = {};
  const abs = path.resolve(file);
  if (existsSync(abs)) {
    try {
      fromFile = JSON.parse(readFileSync(abs, 'utf8'));
    } catch (err) {
      throw new Error(`Impossible de lire ${abs} : ${err.message}`);
    }
    log(`Configuration : ${abs}`);
  } else if (file !== 'config.json') {
    throw new Error(`Fichier de configuration introuvable : ${abs}`);
  } else {
    log('Aucun config.json trouvé : utilisation des valeurs par défaut (copiez config.example.json en config.json).');
  }
  const withEnv = applyEnv(deepMerge(DEFAULT_CONFIG, fromFile), env);
  const merged = deepMerge(withEnv, overrides); // la ligne de commande l'emporte sur l'environnement
  return validateConfig(normalizeConfig(merged));
}
