#!/usr/bin/env node
// Interface graphique locale : un petit serveur HTTP (sans dépendance) qui sert une page web
// pour choisir ses critères, enregistrer config.json, lancer le bot et consulter le rapport.
//   node src/ui/server.js [--port 3939] [--config config.json] [--no-open]
import http from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DEFAULT_CONFIG, deepMerge, loadConfig, normalizeConfig, validateConfig } from '../config.js';
import { DEPARTEMENTS } from '../geo.js';
import { runOnce } from '../run.js';
import { buildReport } from '../report.js';
import { notifyAll } from '../notify/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, 'index.html');

/** Clés de configuration gérées par le formulaire (les autres clés de config.json sont conservées telles quelles). */
const FORM_KEYS = ['zone', 'age_max_mois', 'nouveaux_arrivants', 'inclure_reserves', 'sources', 'notifications', 'planification'];

function readJsonFile(file) {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8'));
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) { reject(new Error('Corps de requête trop volumineux')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('JSON invalide')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

/**
 * Crée l'application (sans l'écouter) — utilisé par les tests.
 * @param {object} opts
 * @param {string} [opts.configFile='config.json']
 * @param {Function} [opts.run]      remplaçant de runOnce (tests)
 * @param {Function} [opts.notify]   remplaçant de notifyAll (tests)
 */
export function createApp({ configFile = 'config.json', run = runOnce, notify = notifyAll, log = () => {} } = {}) {
  const state = { status: 'idle', mode: null, logs: [], report: null, error: null, debut: null, fin: null };
  const pushLog = (msg) => { state.logs.push(`[${new Date().toLocaleTimeString('fr-FR')}] ${msg}`); if (state.logs.length > 2000) state.logs.shift(); };

  const routes = {
    'GET /': (req, res) => send(res, 200, readFileSync(PAGE, 'utf8'), 'text/html; charset=utf-8'),

    'GET /api/config': (req, res) => {
      const fichier = readJsonFile(configFile);
      const config = deepMerge(DEFAULT_CONFIG, fichier);
      send(res, 200, {
        config: pick(config, FORM_KEYS),
        defaults: pick(DEFAULT_CONFIG, FORM_KEYS),
        fichier: path.resolve(configFile),
        fichier_existe: existsSync(configFile),
        departements: Object.entries(DEPARTEMENTS).map(([code, d]) => ({ code, nom: d.nom })).sort((a, b) => a.code.localeCompare(b.code, 'fr', { numeric: true })),
      });
    },

    'POST /api/config': async (req, res) => {
      const body = pick(await readBody(req), FORM_KEYS);
      if (Array.isArray(body.zone?.departements)) {
        body.zone.departements = [...new Set(body.zone.departements.map((d) => { const c = String(d).trim().toUpperCase(); return /^\d$/.test(c) ? `0${c}` : c; }))].sort();
      }
      const existing = readJsonFile(configFile);
      const merged = deepMerge(existing, body);
      try {
        validateConfig(normalizeConfig(deepMerge(DEFAULT_CONFIG, JSON.parse(JSON.stringify(merged)))));
      } catch (err) {
        return send(res, 400, { ok: false, erreurs: String(err.message).replace(/^Configuration invalide :\n/, '').split('\n').map((l) => l.replace(/^ - /, '')).filter(Boolean) });
      }
      mkdirSync(path.dirname(path.resolve(configFile)), { recursive: true });
      writeFileSync(configFile, `${JSON.stringify(merged, null, 2)}\n`);
      log(`Configuration enregistrée : ${path.resolve(configFile)}`);
      send(res, 200, { ok: true, fichier: path.resolve(configFile) });
    },

    'POST /api/run': async (req, res) => {
      if (state.status === 'running') return send(res, 409, { ok: false, erreur: 'Une exécution est déjà en cours.' });
      const { dryRun = true } = await readBody(req);
      let config;
      try {
        config = loadConfig({ file: existsSync(configFile) ? configFile : 'config.json', overrides: { notifications: { console: false } }, log: pushLog });
      } catch (err) {
        return send(res, 400, { ok: false, erreur: err.message });
      }
      Object.assign(state, { status: 'running', mode: dryRun ? 'apercu' : 'reel', logs: [], report: null, error: null, debut: new Date().toISOString(), fin: null });
      pushLog(dryRun ? 'Aperçu (rien n\'est envoyé ni mémorisé)…' : 'Exécution réelle…');
      run(config, { dryRun: Boolean(dryRun), log: pushLog })
        .then((result) => {
          state.report = { ...result.report.json, texte: result.report.text, markdown: result.report.markdown, compte: result.report.compte, titre: result.report.titre };
          state.status = 'done';
        })
        .catch((err) => { state.error = err.message; state.status = 'error'; pushLog(`Erreur : ${err.message}`); })
        .finally(() => { state.fin = new Date().toISOString(); });
      send(res, 202, { ok: true });
    },

    'GET /api/run/status': (req, res) => {
      const from = Number(new URL(req.url, 'http://x').searchParams.get('from') ?? 0) || 0;
      send(res, 200, { status: state.status, mode: state.mode, debut: state.debut, fin: state.fin, error: state.error, logs: state.logs.slice(from), logs_total: state.logs.length, report: state.status === 'done' ? state.report : null });
    },

    'GET /api/report/latest': (req, res) => {
      const dossier = deepMerge(DEFAULT_CONFIG, readJsonFile(configFile)).notifications?.fichier?.dossier ?? 'reports';
      const f = path.join(dossier, 'latest.json');
      if (!existsSync(f)) return send(res, 404, { ok: false, erreur: 'Aucun rapport enregistré pour l\'instant.' });
      send(res, 200, JSON.parse(readFileSync(f, 'utf8')));
    },

    'POST /api/notify-test': async (req, res) => {
      let config;
      try {
        config = loadConfig({ file: existsSync(configFile) ? configFile : 'config.json', log: () => {} });
      } catch (err) {
        return send(res, 400, { ok: false, erreur: err.message });
      }
      const zone = { mode: 'france', label: 'test', centre: null, rayon_km: 0, departements: [] };
      const report = buildReport({ kittens: [], newcomers: [], config, zone, now: new Date(), errors: ['Message de test envoyé depuis l\'interface graphique : les notifications fonctionnent.'] });
      const cfg = { ...config, notifications: { ...config.notifications, console: false, fichier: { ...config.notifications.fichier, actif: false } } };
      const results = await notify(report, cfg, { now: new Date(), log: () => {} });
      const canaux = results.filter((r) => r.canal !== 'console');
      send(res, 200, { ok: canaux.every((r) => r.ok), resultats: canaux });
    },
  };

  return async function app(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key];
    try {
      if (!handler) return send(res, 404, { ok: false, erreur: 'Route inconnue' });
      await handler(req, res);
    } catch (err) {
      send(res, 500, { ok: false, erreur: err.message });
    }
  };
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* navigateur non ouvert : l'URL est affichée dans la console */ }
}

export function startServer({ port = 3939, host = '127.0.0.1', configFile = 'config.json', open = true, log = console.error } = {}) {
  const server = http.createServer(createApp({ configFile, log }));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const url = `http://${host}:${server.address().port}/`;
      log(`Interface disponible sur ${url}  (Ctrl+C pour arrêter)`);
      if (open) openBrowser(url);
      resolve({ server, url });
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const get = (flag, def) => { const i = args.indexOf(flag); return i !== -1 && args[i + 1] ? args[i + 1] : def; };
  startServer({
    port: Number(get('--port', 3939)),
    configFile: get('--config', 'config.json'),
    open: !args.includes('--no-open'),
  }).catch((err) => { console.error(`Impossible de démarrer l'interface : ${err.message}`); process.exitCode = 1; });
}
