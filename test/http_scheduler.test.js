// Tests de src/http.js (client HTTP, postJson), src/scheduler.js (nextOccurrence, scheduleDaily)
// et de la ligne de commande src/index.js (aide, options invalides).
// Aucun accès réseau : createHttp/postJson reçoivent un faux fetch (fetchImpl) qui renvoie de vrais objets Response.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createHttp, postJson, HttpError } from '../src/http.js';
import { nextOccurrence, scheduleDaily } from '../src/scheduler.js';

const RACINE = fileURLToPath(new URL('..', import.meta.url));
const URL_API = 'https://www.la-spa.fr/app/wp-json/spa/v1/animals/count/?api=1';
const URL_WEBHOOK = 'https://discord.com/api/webhooks/123/abc';

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Faux fetch : chaque appel consomme l'étape suivante de `etapes`.
 * Une étape est soit une Response, soit une Error (levée), soit une fonction (url, init) → Response | Promise.
 * La dernière étape est rejouée si les appels dépassent la liste.
 */
function fauxFetch(...etapes) {
  const appels = [];
  const fetchImpl = async (url, init = {}) => {
    appels.push({ url, init });
    const etape = etapes[Math.min(appels.length - 1, etapes.length - 1)];
    if (etape instanceof Error) throw etape;
    if (typeof etape === 'function') return etape(url, init);
    return etape.clone();
  };
  return { fetchImpl, appels };
}

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
const texte = (body, status = 200, headers = {}) => new Response(body, { status, headers });
const vide204 = () => new Response(null, { status: 204 }); // statut « sans corps » : body doit être null

/** Fetch qui n'aboutit jamais mais, comme le vrai fetch, rejette quand le signal est interrompu. */
const fetchSansReponse = (url, { signal }) => new Promise((_, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

/** Client de test : pas de pause de politesse ni de journal, sauf indication contraire. */
const client = (opts) => createHttp({ delayMs: 0, retries: 3, ...opts });

describe('createHttp — getJson / getText', () => {
  test('getJson analyse la réponse JSON et envoie user-agent, accept JSON et accept-language', async () => {
    const { fetchImpl, appels } = fauxFetch(json({ count: 2406 }));
    const http = client({ fetchImpl, userAgent: 'robot-test/9.9' });

    assert.deepEqual(await http.getJson(URL_API), { count: 2406 });

    assert.equal(appels.length, 1);
    assert.equal(appels[0].url, URL_API);
    const { headers, signal, redirect } = appels[0].init;
    assert.equal(headers['user-agent'], 'robot-test/9.9');
    assert.match(headers.accept, /^application\/json/);
    assert.match(headers['accept-language'], /^fr-FR/);
    assert.equal(redirect, 'follow');
    assert.ok(signal instanceof AbortSignal, 'un signal d’interruption doit être transmis à fetch');
  });

  test('getJson fusionne les en-têtes personnalisés (ils priment sur les en-têtes par défaut)', async () => {
    const { fetchImpl, appels } = fauxFetch(json([]));
    const http = client({ fetchImpl });

    await http.getJson(URL_API, { headers: { 'x-essai': 'oui', 'accept-language': 'en' } });

    assert.equal(appels[0].init.headers['x-essai'], 'oui');
    assert.equal(appels[0].init.headers['accept-language'], 'en');
  });

  test('getText renvoie le HTML brut et demande du text/html', async () => {
    const html = '<html><body><h3>Sweety</h3></body></html>';
    const { fetchImpl, appels } = fauxFetch(texte(html, 200, { 'content-type': 'text/html' }));
    const http = client({ fetchImpl });

    assert.equal(await http.getText('https://www.secondechance.org/animal/recherche?species=2'), html);
    assert.match(appels[0].init.headers.accept, /^text\/html/);
  });

  test('getJson : une réponse non JSON lève une HttpError (statut, URL, extrait) sans nouvelle tentative', async () => {
    const { fetchImpl, appels } = fauxFetch(texte('<!DOCTYPE html><title>Maintenance</title>', 200));
    const http = client({ fetchImpl });

    await assert.rejects(http.getJson(URL_API), (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.name, 'HttpError');
      assert.equal(err.status, 200);
      assert.equal(err.url, URL_API);
      assert.match(err.message, /Réponse non JSON/);
      assert.match(err.message, /Maintenance/);
      return true;
    });
    assert.equal(appels.length, 1);
    assert.equal(http.stats.retries, 0);
  });

  test('HTTP 500 puis 200 : réussit après exactement une nouvelle tentative (stats.retries = 1)', async () => {
    const journal = [];
    const { fetchImpl, appels } = fauxFetch(texte('panne', 500), json({ ok: true }));
    const http = client({ fetchImpl, log: (m) => journal.push(m) });

    assert.deepEqual(await http.getJson(URL_API), { ok: true });

    assert.equal(appels.length, 2);
    assert.equal(http.stats.requests, 2);
    assert.equal(http.stats.retries, 1);
    assert.equal(http.stats.failures, 0);
    assert.equal(journal.length, 1);
    assert.match(journal[0], /Nouvelle tentative \(1\/3\).*HTTP 500/);
  });

  test('HTTP 404 : HttpError immédiate, sans nouvelle tentative', async () => {
    const { fetchImpl, appels } = fauxFetch(texte('introuvable', 404));
    const http = client({ fetchImpl });

    await assert.rejects(http.getJson(URL_API), (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 404);
      assert.equal(err.url, URL_API);
      assert.match(err.message, /HTTP 404/);
      return true;
    });
    assert.equal(appels.length, 1);
    assert.equal(http.stats.requests, 1);
    assert.equal(http.stats.retries, 0);
  });

  test('HTTP 503 persistant : abandonne après « retries » tentatives avec le dernier statut', async () => {
    const { fetchImpl, appels } = fauxFetch(texte('surcharge', 503));
    const http = client({ fetchImpl, retries: 2 });

    await assert.rejects(http.getJson(URL_API), { name: 'HttpError', status: 503 });
    assert.equal(appels.length, 2);
    assert.equal(http.stats.retries, 1);
  });

  test('erreur réseau puis succès : la requête est réessayée', async () => {
    const { fetchImpl, appels } = fauxFetch(new TypeError('fetch failed'), json({ total: 1 }));
    const http = client({ fetchImpl });

    assert.deepEqual(await http.getJson(URL_API), { total: 1 });
    assert.equal(appels.length, 2);
    assert.equal(http.stats.retries, 1);
  });

  test('erreur réseau à la dernière tentative : HttpError « Erreur réseau » et stats.failures = 1', async () => {
    const { fetchImpl } = fauxFetch(new TypeError('fetch failed'));
    const http = client({ fetchImpl, retries: 1 });

    await assert.rejects(http.getJson(URL_API), (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, null);
      assert.match(err.message, /Erreur réseau .* fetch failed/);
      return true;
    });
    assert.equal(http.stats.failures, 1);
  });

  test('délai dépassé (fetch qui n’aboutit pas, timeoutMs court) : HttpError « Délai dépassé »', async () => {
    const http = client({ fetchImpl: fetchSansReponse, timeoutMs: 30, retries: 1 });
    const debut = Date.now();

    await assert.rejects(http.getJson(URL_API), (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, null);
      assert.equal(err.url, URL_API);
      assert.match(err.message, /Délai dépassé \(30 ms\)/);
      return true;
    });
    assert.ok(Date.now() - debut < 1000, 'l’interruption doit intervenir peu après timeoutMs');
    assert.equal(http.stats.requests, 1);
    assert.equal(http.stats.failures, 1);
  });

  test('concurrence limitée : jamais plus de N requêtes en vol simultanément', async () => {
    let enVol = 0;
    let maxEnVol = 0;
    const fetchImpl = async (url) => {
      enVol += 1;
      maxEnVol = Math.max(maxEnVol, enVol);
      await attendre(20);
      enVol -= 1;
      return json({ url });
    };
    const http = client({ fetchImpl, concurrency: 2 });
    const urls = Array.from({ length: 6 }, (_, i) => `${URL_API}&paged=${i + 1}`);

    const resultats = await Promise.all(urls.map((u) => http.getJson(u)));

    assert.equal(maxEnVol, 2, 'la limite doit être atteinte mais jamais dépassée');
    assert.deepEqual(resultats.map((r) => r.url), urls, 'chaque promesse reçoit sa propre réponse');
    assert.equal(http.stats.requests, 6);
  });

  test('concurrence 0 est ramenée à 1 : les requêtes passent une par une sans blocage', async () => {
    let enVol = 0;
    let maxEnVol = 0;
    const fetchImpl = async () => {
      enVol += 1;
      maxEnVol = Math.max(maxEnVol, enVol);
      await attendre(5);
      enVol -= 1;
      return json({});
    };
    const http = client({ fetchImpl, concurrency: 0 });

    await Promise.all([1, 2, 3].map(() => http.getJson(URL_API)));
    assert.equal(maxEnVol, 1);
  });

  test('stats.requests compte chaque tentative, cumulée sur plusieurs appels', async () => {
    const { fetchImpl } = fauxFetch(json({ a: 1 }), texte('introuvable', 404));
    const http = client({ fetchImpl });

    await http.getJson(URL_API);
    await assert.rejects(http.getJson(URL_API), { status: 404 });
    await assert.rejects(http.getText(URL_API), { status: 404 });

    assert.deepEqual({ requests: http.stats.requests, retries: http.stats.retries }, { requests: 3, retries: 0 });
  });

  test('pause de politesse (delayMs) respectée entre deux requêtes successives', async () => {
    const debuts = [];
    const fetchImpl = async () => { debuts.push(Date.now()); return json({}); };
    const http = createHttp({ fetchImpl, delayMs: 60, concurrency: 1, retries: 1 });

    await http.getJson(URL_API);
    await http.getJson(URL_API);

    assert.ok(debuts[1] - debuts[0] >= 55, `écart mesuré : ${debuts[1] - debuts[0]} ms`);
  });

  test('pause de politesse respectée aussi entre requêtes concurrentes', async () => {
    const debuts = [];
    const fetchImpl = async () => { debuts.push(Date.now()); return json({}); };
    const http = createHttp({ fetchImpl, delayMs: 60, concurrency: 3, retries: 1 });

    await Promise.all([1, 2, 3].map(() => http.getJson(URL_API)));

    const ecarts = debuts.sort((a, b) => a - b).slice(1).map((t, i) => t - debuts[i]);
    assert.ok(ecarts.every((e) => e >= 55), `écarts mesurés entre départs : ${ecarts.join(', ')} ms (attendu ≥ 60)`);
  });

  test('le délai d’attente couvre aussi la lecture du corps de la réponse', async () => {
    // En-têtes reçus, puis corps qui ne finit jamais (seul l’abort du signal peut l’interrompre, comme avec undici).
    const fetchImpl = async (url, { signal }) => ({
      ok: true,
      status: 200,
      text: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    });
    const http = client({ fetchImpl, timeoutMs: 30, retries: 1 });

    let garde;
    const issue = await Promise.race([
      http.getJson(URL_API).then(() => 'résolu', (err) => err),
      new Promise((r) => { garde = setTimeout(() => r('toujours bloqué après 1 s'), 1000); }),
    ]);
    clearTimeout(garde);

    assert.ok(issue instanceof HttpError, `attendu une HttpError, obtenu : ${issue}`);
    assert.match(issue.message, /Délai dépassé/);
  });

  test('stats.failures compte aussi les échecs HTTP définitifs (404, 5xx épuisés)', async () => {
    const { fetchImpl } = fauxFetch(texte('introuvable', 404));
    const http = client({ fetchImpl });

    await assert.rejects(http.getJson(URL_API), { status: 404 });
    assert.equal(http.stats.failures, 1);
  });
});

describe('postJson', () => {
  test('envoie un POST JSON avec content-type, user-agent et en-têtes supplémentaires', async () => {
    const { fetchImpl, appels } = fauxFetch(vide204());
    const corps = { content: 'Nouveaux chatons', username: 'Annonces chatons' };

    const res = await postJson(URL_WEBHOOK, corps, { fetchImpl, userAgent: 'robot-test/9.9', headers: { 'x-essai': '1' } });

    assert.equal(res.status, 204);
    assert.equal(appels.length, 1);
    const { init } = appels[0];
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), corps);
    assert.equal(init.headers['content-type'], 'application/json');
    assert.equal(init.headers['user-agent'], 'robot-test/9.9');
    assert.equal(init.headers['x-essai'], '1');
    assert.ok(init.signal instanceof AbortSignal);
  });

  test('429 avec retry-after puis 200 : attend le délai demandé puis réussit', async () => {
    const { fetchImpl, appels } = fauxFetch(
      json({ message: 'You are being rate limited.' }, 429, { 'retry-after': '1' }),
      json({ ok: true }),
    );
    const debut = Date.now();

    const res = await postJson(URL_WEBHOOK, { content: 'x' }, { fetchImpl });

    const ecoule = Date.now() - debut;
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(appels.length, 2);
    assert.ok(ecoule >= 950, `retry-after: 1 doit imposer ≈ 1 s d’attente (mesuré : ${ecoule} ms, défaut 500 ms)`);
  });

  test('400 : HttpError immédiate avec le corps de la réponse, sans nouvelle tentative', async () => {
    const { fetchImpl, appels } = fauxFetch(json({ description: 'Bad Request: chat not found' }, 400));

    await assert.rejects(postJson(URL_WEBHOOK, { text: 'x' }, { fetchImpl }), (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 400);
      assert.equal(err.url, URL_WEBHOOK);
      assert.match(err.message, /chat not found/);
      return true;
    });
    assert.equal(appels.length, 1);
  });

  test('erreur réseau puis succès : le POST est réessayé', async () => {
    const { fetchImpl, appels } = fauxFetch(new TypeError('fetch failed'), vide204());

    const res = await postJson(URL_WEBHOOK, { content: 'x' }, { fetchImpl });
    assert.equal(res.status, 204);
    assert.equal(appels.length, 2);
  });

  test('statut réessayable à la dernière tentative : échoue sans attente inutile', async () => {
    const { fetchImpl, appels } = fauxFetch(texte('indisponible', 503));
    const debut = Date.now();

    await assert.rejects(postJson(URL_WEBHOOK, { content: 'x' }, { fetchImpl, retries: 1 }), { status: 503 });

    const ecoule = Date.now() - debut;
    assert.equal(appels.length, 1);
    assert.ok(ecoule < 250, `aucune pause attendue après la dernière tentative (mesuré : ${ecoule} ms)`);
  });
});

describe('nextOccurrence', () => {
  const iso = (d) => d.toISOString();
  const partsLocales = (date, timeZone) => {
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const p = Object.fromEntries(f.formatToParts(date).map(({ type, value }) => [type, value]));
    return { jour: `${p.year}-${p.month}-${p.day}`, heure: `${p.hour}:${p.minute}` };
  };
  const lendemain = (jour) => new Date(Date.UTC(...jour.split('-').map((v, i) => Number(v) - (i === 1 ? 1 : 0))) + 86_400_000)
    .toISOString().slice(0, 10);

  test('08:00 Europe/Paris en été (UTC+2) → 06:00Z le jour même', () => {
    const from = new Date('2026-07-15T04:00:00Z'); // 06:00 à Paris
    assert.equal(iso(nextOccurrence('08:00', 'Europe/Paris', from)), '2026-07-15T06:00:00.000Z');
  });

  test('08:00 Europe/Paris en hiver (UTC+1) → 07:00Z le jour même', () => {
    const from = new Date('2026-01-15T05:00:00Z'); // 06:00 à Paris
    assert.equal(iso(nextOccurrence('08:00', 'Europe/Paris', from)), '2026-01-15T07:00:00.000Z');
  });

  test('heure déjà passée → lendemain', () => {
    const from = new Date('2026-07-15T10:00:00Z'); // 12:00 à Paris
    assert.equal(iso(nextOccurrence('08:00', 'Europe/Paris', from)), '2026-07-16T06:00:00.000Z');
  });

  test('strictement après « from » : pile à l’heure → lendemain, 1 ms avant → jour même', () => {
    const pile = new Date('2026-07-15T06:00:00Z');
    assert.equal(iso(nextOccurrence('08:00', 'Europe/Paris', pile)), '2026-07-16T06:00:00.000Z');
    const juste = new Date(pile.getTime() - 1);
    assert.equal(iso(nextOccurrence('08:00', 'Europe/Paris', juste)), '2026-07-15T06:00:00.000Z');
  });

  test('veille du passage à l’heure d’été (29/03/2026) → 08:00 CEST, soit 06:00Z', () => {
    const from = new Date('2026-03-28T08:00:00Z'); // samedi 09:00 CET
    assert.equal(iso(nextOccurrence('08:00', 'Europe/Paris', from)), '2026-03-29T06:00:00.000Z');
  });

  test('veille du passage à l’heure d’hiver (25/10/2026) → 08:00 CET, soit 07:00Z', () => {
    const from = new Date('2026-10-24T08:00:00Z'); // samedi 10:00 CEST
    assert.equal(iso(nextOccurrence('08:00', 'Europe/Paris', from)), '2026-10-25T07:00:00.000Z');
  });

  test('fuseau sans heure d’été (Asia/Tokyo, UTC+9) : même instant UTC en janvier et en juillet', () => {
    // 09:00 à Tokyo → 08:00 est passé → lendemain 08:00 JST = 23:00Z du jour UTC courant.
    assert.equal(iso(nextOccurrence('08:00', 'Asia/Tokyo', new Date('2026-07-15T00:00:00Z'))), '2026-07-15T23:00:00.000Z');
    assert.equal(iso(nextOccurrence('08:00', 'Asia/Tokyo', new Date('2026-01-15T00:00:00Z'))), '2026-01-15T23:00:00.000Z');
    // 05:00 à Tokyo le 15/07 → 08:00 JST le même jour local = 23:00Z la veille (UTC).
    assert.equal(iso(nextOccurrence('08:00', 'Asia/Tokyo', new Date('2026-07-14T20:00:00Z'))), '2026-07-14T23:00:00.000Z');
  });

  test('décalage non entier (Asia/Kolkata, UTC+5:30) et minutes prises en compte', () => {
    const from = new Date('2026-07-15T00:00:00Z'); // 05:30 à Kolkata
    assert.equal(iso(nextOccurrence('08:00', 'Asia/Kolkata', from)), '2026-07-15T02:30:00.000Z');
    assert.equal(iso(nextOccurrence('18:45', 'Asia/Kolkata', from)), '2026-07-15T13:15:00.000Z');
  });

  test('UTC : l’heure locale est l’heure UTC', () => {
    assert.equal(iso(nextOccurrence('08:00', 'UTC', new Date('2026-09-24T07:59:00Z'))), '2026-09-24T08:00:00.000Z');
  });

  test('passage au mois et à l’année suivants', () => {
    // 31/12/2026 23:00 à Paris : 23:59 est encore à venir le jour même.
    assert.equal(iso(nextOccurrence('23:59', 'Europe/Paris', new Date('2026-12-31T22:00:00Z'))), '2026-12-31T22:59:00.000Z');
    // 01/01/2027 00:30 à Paris : 23:59 du 01/01.
    assert.equal(iso(nextOccurrence('23:59', 'Europe/Paris', new Date('2026-12-31T23:30:00Z'))), '2027-01-01T22:59:00.000Z');
    // 31/07 23:00 à Paris → 00:30 le 01/08.
    assert.equal(iso(nextOccurrence('00:30', 'Europe/Paris', new Date('2026-07-31T21:00:00Z'))), '2026-07-31T22:30:00.000Z');
  });

  test('propriété : heure par heure autour des changements d’heure, toujours 08:00 local au bon jour', () => {
    for (const debutSemaine of ['2026-03-26T00:00:00Z', '2026-10-22T00:00:00Z']) {
      for (let h = 0; h < 24 * 6; h += 1) {
        const from = new Date(Date.parse(debutSemaine) + h * 3_600_000 + 17 * 60_000); // HH:17 UTC
        const next = nextOccurrence('08:00', 'Europe/Paris', from);
        const local = partsLocales(next, 'Europe/Paris');
        const depart = partsLocales(from, 'Europe/Paris');
        const jourAttendu = depart.heure < '08:00' ? depart.jour : lendemain(depart.jour);
        assert.equal(local.heure, '08:00', `heure locale pour from=${iso(from)}`);
        assert.equal(local.jour, jourAttendu, `jour local pour from=${iso(from)}`);
        assert.ok(next > from, `résultat postérieur à from=${iso(from)}`);
      }
    }
  });

  test('sans « from » : prochaine occurrence dans les 25 h à venir', () => {
    const avant = Date.now();
    const next = nextOccurrence('08:00', 'Europe/Paris');
    assert.ok(next.getTime() > avant);
    assert.ok(next.getTime() - avant <= 25 * 3_600_000);
  });
});

describe('scheduleDaily', () => {
  test('signal déjà interrompu : annonce la planification mais n’exécute jamais la tâche', async () => {
    const journal = [];
    const controller = new AbortController();
    controller.abort();
    let executions = 0;

    await scheduleDaily({ heure: '08:00', fuseau: 'Europe/Paris' }, async () => { executions += 1; }, {
      log: (m) => journal.push(m),
      signal: controller.signal,
    });

    assert.equal(executions, 0);
    assert.equal(journal.length, 1);
    assert.match(journal[0], /Planification : tous les jours à 08:00 \(Europe\/Paris\)/);
  });
});

describe('ligne de commande (src/index.js)', () => {
  /** Lance la CLI dans un processus séparé ; renvoie { status, stdout, stderr } même en cas d’échec. */
  function lancerCli(args) {
    try {
      const stdout = execFileSync(process.execPath, ['src/index.js', ...args], {
        cwd: RACINE, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      if (err.status == null) throw err; // délai dépassé ou signal : vrai échec du test
      return { status: err.status, stdout: err.stdout, stderr: err.stderr };
    }
  }

  test('--help (et son alias -h) affiche l’aide sur la sortie standard et termine avec le code 0', () => {
    for (const drapeau of ['--help', '-h']) {
      const { status, stdout } = lancerCli([drapeau]);
      assert.equal(status, 0, `code de sortie pour ${drapeau}`);
      assert.match(stdout, /^Usage : node src\/index\.js \[options\]/);
      for (const option of ['--config', '--loop', '--dry-run', '--rayon', '--age-max', '--sans-laspa', '-h, --help']) {
        assert.ok(stdout.includes(option), `l’aide (${drapeau}) doit mentionner ${option}`);
      }
    }
  });

  test('--help l’emporte sur les autres options (aucune exécution réelle)', () => {
    const { status, stdout } = lancerCli(['--dry-run', '--rayon', '30', '--help']);
    assert.equal(status, 0);
    assert.match(stdout, /^Usage :/);
  });

  test('option inconnue → code de sortie 1, message d’erreur et aide sur stderr', () => {
    const { status, stdout, stderr } = lancerCli(['--chien']);
    assert.equal(status, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /Erreur : Option inconnue : --chien/);
    assert.match(stderr, /Usage :/);
  });

  test('valeur numérique invalide → code de sortie 1', () => {
    const { status, stderr } = lancerCli(['--rayon', 'loin']);
    assert.equal(status, 1);
    assert.match(stderr, /Valeur numérique attendue pour --rayon : loin/);
  });

  test('valeur manquante → code de sortie 1', () => {
    const { status, stderr } = lancerCli(['--config']);
    assert.equal(status, 1);
    assert.match(stderr, /Valeur manquante pour --config/);
  });
});
