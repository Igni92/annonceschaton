// Interface graphique locale : routes de l'API (sans réseau, configuration dans un dossier temporaire).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/ui/server.js';

let dir, configFile, server, base;
const runs = [];

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'annonces-ui-'));
  configFile = path.join(dir, 'config.json');
  const fauxRun = async (config, { dryRun, log }) => {
    runs.push({ dryRun, mode: config.zone.mode });
    log('faux run');
    return { report: { json: { chatons: [], nouveaux_arrivants: [], stats: {} }, text: 'txt', markdown: 'md', compte: { chatons: 0, nouveaux: 0 }, titre: 'T' } };
  };
  const fauxNotify = async () => [{ canal: 'console', ok: true }, { canal: 'discord', ok: false, erreur: 'HTTP 404' }];
  server = http.createServer(createApp({ configFile, run: fauxRun, notify: fauxNotify }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, text, json };
};

describe('interface graphique', () => {
  test('GET / sert la page HTML en français', async () => {
    const r = await call('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.text, /<html lang="fr">/);
    assert.match(r.text, /Annonces chatons/);
  });

  test('GET /api/config : valeurs par défaut, liste des départements, fichier absent', async () => {
    const r = await call('GET', '/api/config');
    assert.equal(r.status, 200);
    assert.equal(r.json.fichier_existe, false);
    assert.equal(r.json.config.age_max_mois, 4);
    assert.equal(r.json.departements.length, 101);
    assert.ok(r.json.departements.some((d) => d.code === '2A'));
  });

  test('POST /api/config invalide : 400 avec les erreurs en français, rien n\'est écrit', async () => {
    const r = await call('POST', '/api/config', { zone: { mode: 'rayon', rayon_km: 0 }, age_max_mois: -1 });
    assert.equal(r.status, 400);
    assert.ok(r.json.erreurs.some((e) => e.includes('rayon_km')));
    assert.ok(r.json.erreurs.some((e) => e.includes('age_max_mois')));
    assert.equal(existsSync(configFile), false);
  });

  test('POST /api/config valide : écrit config.json et conserve les clés hors formulaire', async () => {
    const r = await call('POST', '/api/config', { zone: { mode: 'departements', departements: ['69', '1'] }, age_max_mois: 5 });
    assert.equal(r.status, 200);
    const saved = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(saved.zone.mode, 'departements');
    assert.equal(saved.age_max_mois, 5);
    const again = await call('GET', '/api/config');
    assert.equal(again.json.fichier_existe, true);
    assert.deepEqual(again.json.config.zone.departements, ['01', '69']);
    assert.equal(again.json.departements[0].code, '01');
  });

  test('POST /api/run lance une exécution (aperçu par défaut) puis le statut expose journal et rapport', async () => {
    const r = await call('POST', '/api/run', { dryRun: true });
    assert.equal(r.status, 202);
    let status;
    for (let i = 0; i < 50; i += 1) {
      status = (await call('GET', '/api/run/status')).json;
      if (status.status !== 'running') break;
      await new Promise((res) => setTimeout(res, 20));
    }
    assert.equal(status.status, 'done');
    assert.equal(status.mode, 'apercu');
    assert.ok(status.logs.some((l) => l.includes('faux run')));
    assert.deepEqual(status.report.chatons, []);
    assert.equal(runs.at(-1).dryRun, true);
    assert.equal(runs.at(-1).mode, 'departements');
  });

  test('POST /api/notify-test renvoie le résultat par canal (hors console)', async () => {
    const r = await call('POST', '/api/notify-test');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, false);
    assert.deepEqual(r.json.resultats.map((x) => x.canal), ['discord']);
  });

  test('route inconnue : 404 JSON', async () => {
    const r = await call('GET', '/inconnue');
    assert.equal(r.status, 404);
  });
});
