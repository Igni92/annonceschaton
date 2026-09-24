// Une exécution complète : sources → filtres → rapport → notifications → état.
import { createHttp } from './http.js';
import { loadState, saveState, markSeen, pruneState } from './state.js';
import { buildZone, selectKittens, selectNewcomers, dedupe } from './filters.js';
import { buildReport } from './report.js';
import { notifyAll } from './notify/index.js';
import { fetchLaSpa } from './sources/laspa.js';
import { fetchSecondeChance } from './sources/secondechance.js';

export const SOURCES = {
  laspa: fetchLaSpa,
  secondechance: fetchSecondeChance,
};

/**
 * @param {object} config          configuration validée (loadConfig)
 * @param {object} [opts]
 * @param {Date}   [opts.now]
 * @param {boolean} [opts.dryRun]  n'envoie rien (sauf console) et ne modifie pas l'état
 * @param {Function} [opts.log]
 * @param {Function} [opts.fetchImpl]
 * @param {object} [opts.sources]  surcharge des sources (tests)
 * @returns {Promise<{report: object, kittens: object[], newcomers: object[], listings: object[], stats: object, errors: string[]}>}
 */
export async function runOnce(config, { now = new Date(), dryRun = false, log = console.error, fetchImpl, sources = SOURCES } = {}) {
  const started = Date.now();
  const http = createHttp({
    userAgent: config.http.user_agent,
    timeoutMs: config.http.timeout_ms,
    retries: config.http.tentatives,
    concurrency: config.http.concurrence,
    delayMs: config.http.delai_ms,
    fetchImpl,
    log,
  });
  const errors = [];
  const state = loadState(config.etat.fichier, log);
  const zone = await buildZone(config, http, log);

  const all = [];
  const stats = { sources: {} };
  const firstRun = !state.derniere_execution;
  const context = { firstRun };
  for (const [name, fetcher] of Object.entries(sources)) {
    if (!config.sources?.[name]?.actif) continue;
    try {
      const { listings, stats: s } = await fetcher({ http, config, state, zone, now, log, context });
      stats.sources[name] = s;
      all.push(...listings);
      if (s?.erreurs) errors.push(`${name} : ${s.erreurs} fiche(s) non lue(s).`);
    } catch (err) {
      const msg = `Source ${name} indisponible : ${err.message}`;
      errors.push(msg);
      log(msg);
      stats.sources[name] = { erreur: err.message };
    }
  }

  const listings = dedupe(all);
  // Détection des annonces jamais vues (sur une copie si --dry-run pour ne pas altérer l'état).
  const stateForRun = dryRun ? JSON.parse(JSON.stringify(state)) : state;
  const fresh = markSeen(stateForRun, listings, now);
  // Au tout premier lancement, tout serait « jamais vu » : on ne retient que les dates de mise en ligne.
  let effectiveConfig = config;
  if (firstRun && config.nouveaux_arrivants.critere !== 'date_publication') {
    effectiveConfig = { ...config, nouveaux_arrivants: { ...config.nouveaux_arrivants, critere: 'date_publication' } };
    errors.push("Première exécution : la mémoire du bot est vide, les nouveaux arrivants sont déterminés d'après la date de mise en ligne uniquement (détection « jamais vus » active dès la prochaine exécution).");
  }

  const kittens = selectKittens(listings, config);
  const newcomers = selectNewcomers(listings, effectiveConfig, { state: stateForRun, fresh, now });

  stats.requests = http.stats.requests;
  stats.retries = http.stats.retries;
  stats.duree_s = Math.round((Date.now() - started) / 100) / 10;
  stats.annonces_zone = listings.length;

  const report = buildReport({ kittens, newcomers, config: effectiveConfig, zone, now, stats, errors });
  await notifyAll(report, config, { now, dryRun, log, fetchImpl });

  if (!dryRun) {
    stateForRun.derniere_execution = now.toISOString();
    const removed = pruneState(stateForRun, config.etat.retention_jours, now);
    if (removed) log(`État : ${removed} entrée(s) purgée(s).`);
    saveState(config.etat.fichier, stateForRun);
  }
  log(`Terminé en ${stats.duree_s} s — ${kittens.length} chaton(s), ${report.compte.nouveaux} nouvel(aux) arrivant(s), ${stats.requests} requêtes.`);
  return { report, kittens, newcomers, listings, stats, errors };
}
