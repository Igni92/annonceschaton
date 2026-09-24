// Tests de src/report.js (describe, buildReport) et des canaux de notification src/notify/*
// (chunkText, Discord, Telegram, fichier, notifyAll).
// Aucun accès réseau : un faux fetch (fetchImpl) enregistre les requêtes et renvoie de vraies `Response`.
// « Maintenant » est figé ; les rapports sont écrits dans des dossiers temporaires (os.tmpdir()).

import { after, describe as suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildReport, describe } from '../src/report.js';
import { DEFAULT_CONFIG, deepMerge } from '../src/config.js';
import { chunkText, notifyDiscord } from '../src/notify/discord.js';
import { notifyTelegram } from '../src/notify/telegram.js';
import { localDate, notifyFile } from '../src/notify/file.js';
import { notifyAll } from '../src/notify/index.js';

/** « Maintenant » figé : jeudi 24/09/2026 à 08:00, heure de Paris (06:00 UTC). */
const MAINTENANT = new Date('2026-09-24T06:00:00.000Z');
/** Jeudi 24/09/2026 à 23:30 UTC = vendredi 25/09/2026 à 01:30 à Paris. */
const TARD_LE_SOIR = new Date('2026-09-24T23:30:00.000Z');

const WEBHOOK = 'https://discord.com/api/webhooks/123/secret-webhook-token';
const BOT_TOKEN = '123456:SECRET-bot-token';

// ---------------------------------------------------------------------------------------------
// Fabriques d'annonces (même forme que les sources : src/sources/laspa.js et secondechance.js).
// ---------------------------------------------------------------------------------------------

/** Chat SPA au refuge de Gennevilliers (coordonnées exactes, ≈ 10,6 km du centre de Paris). */
function annonceSpa(over = {}) {
  const { lieu, ...rest } = over;
  return {
    id: 'laspa:1001',
    source: 'laspa',
    source_label: 'La SPA',
    nom: 'Ella',
    url: 'https://www.la-spa.fr/adoption/chats/ella-1001/',
    race: 'Européen',
    sexe: 'femelle',
    age_mois: 2.8,
    date_naissance: '2026-07-01',
    date_publication: '2026-09-21',
    reserve: false,
    lieu: {
      nom: 'La SPA - Refuge de Gennevilliers – Grammont',
      ville: 'Gennevilliers',
      code_postal: '92230',
      departement: '92',
      latitude: 48.9447,
      longitude: 2.3036,
      precision: 'exacte',
      distance_km: 10.6,
      ...lieu,
    },
    description: null,
    _now: MAINTENANT,
    ...rest,
  };
}

/** Chat Seconde Chance : association AFELP (95300 Pontoise), animal adoptable dans le 75 (fiche lue). */
function annonceSc(over = {}) {
  const { lieu, ...rest } = over;
  return {
    id: 'secondechance:1519999',
    source: 'secondechance',
    source_label: 'Seconde Chance',
    nom: 'Sweety',
    url: 'https://www.secondechance.org/animal/chat-europeen-sweety-1519999',
    race: 'EUROPÉEN',
    sexe: 'male',
    age_mois: 6.8,
    date_naissance: '2026-03-01',
    date_publication: '2026-09-24',
    reserve: false,
    lieu: {
      nom: 'AFELP',
      ville: 'Pontoise',
      code_postal: '95300',
      departement: '75',
      departement_association: '95',
      departements_adoption: ['75'],
      latitude: null,
      longitude: null,
      precision: 'departement',
      distance_km: null,
      ...lieu,
    },
    description: null,
    ...rest,
  };
}

/** Configuration complète (défauts du projet) + surcharges. */
function configRapport(over = {}) {
  return deepMerge(DEFAULT_CONFIG, over);
}

const ZONE = {
  mode: 'rayon',
  label: '50 km autour de Paris',
  centre: { latitude: 48.857, longitude: 2.352 },
  rayon_km: 50,
  departements: [],
};

function rapport(args = {}) {
  return buildReport({
    kittens: [],
    newcomers: [],
    config: configRapport(),
    zone: ZONE,
    now: MAINTENANT,
    ...args,
  });
}

// ---------------------------------------------------------------------------------------------
// Faux fetch : enregistre chaque appel et renvoie une vraie Response (API fetch de Node).
// ---------------------------------------------------------------------------------------------

function fauxFetch(repondre = () => new Response(null, { status: 204 })) {
  const appels = [];
  const fetchImpl = async (url, init = {}) => {
    appels.push({ url: String(url), init, corps: init.body ? JSON.parse(init.body) : null });
    return repondre(String(url), init, appels.length);
  };
  return { fetchImpl, appels };
}

const reponseTelegramOk = () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
  status: 200, headers: { 'content-type': 'application/json' },
});

// Dossiers temporaires nettoyés à la fin.
const dossiersTemp = [];
function dossierTemp() {
  const d = mkdtempSync(path.join(os.tmpdir(), 'annonceschaton-report-'));
  dossiersTemp.push(d);
  return d;
}
after(() => {
  for (const d of dossiersTemp) rmSync(d, { recursive: true, force: true });
});

// =============================================================================================
// describe() : champs prêts à afficher
// =============================================================================================

suite('describe() — champs affichés pour une annonce', () => {
  test('annonce SPA : âge avec date de naissance, sexe, date de mise en ligne, source', () => {
    const d = describe(annonceSpa());
    assert.equal(d.nom, 'Ella');
    assert.equal(d.source, 'La SPA');
    assert.equal(d.age, '2 mois (né·e le 01/07/2026)');
    assert.equal(d.sexe, '♀ femelle');
    assert.equal(d.race, 'Européen');
    assert.equal(d.publication, 'mis en ligne le 21/09/2026');
    assert.equal(d.reserve, null);
    assert.equal(d.url, 'https://www.la-spa.fr/adoption/chats/ella-1001/');
  });

  test('lieu SPA : nom du refuge + distance arrondie « 11 km » (ville non répétée si déjà dans le nom)', () => {
    assert.equal(describe(annonceSpa()).lieu, 'La SPA - Refuge de Gennevilliers – Grammont · 11 km');
  });

  test('lieu SPA : ville et département ajoutés quand le nom du refuge ne contient pas la ville', () => {
    const l = annonceSpa({ lieu: { nom: 'Maison SPA du Val', ville: 'Orgeval', departement: '78', distance_km: 26.4 } });
    assert.equal(describe(l).lieu, 'Maison SPA du Val · Orgeval (78) · 26 km');
  });

  test('lieu Seconde Chance : « adoptable dans le 75 » quand le département diffère de celui de l\'association', () => {
    assert.equal(describe(annonceSc()).lieu, 'AFELP · Pontoise (95) · adoptable dans le 75');
  });

  test('lieu Seconde Chance : pas de mention « adoptable dans » si le département est celui de l\'association', () => {
    const l = annonceSc({ lieu: { ville: 'Paris', code_postal: '75011', departement_association: '75' } });
    assert.equal(describe(l).lieu, 'AFELP · Paris (75)');
  });

  test('lieu Seconde Chance : jamais de distance (précision « departement »), même si distance_km est renseigné', () => {
    const d = describe(annonceSc({ lieu: { distance_km: 12.3 } }));
    assert.doesNotMatch(d.lieu, /km/);
    assert.equal(d.lieu, 'AFELP · Pontoise (95) · adoptable dans le 75');
  });

  test('lieu Seconde Chance sans fiche (association inconnue) et adoptable dans plusieurs départements', () => {
    const l = annonceSc({ lieu: { nom: '4 pattes en danger', ville: null, departement_association: null, departements_adoption: ['75', '92'] } });
    assert.equal(describe(l).lieu, '4 pattes en danger · adoptable dans le 75, 92');
  });

  test('valeurs par défaut : sans nom, âge inconnu, sexe inconnu, réservé, sans date de mise en ligne', () => {
    const d = describe(annonceSpa({ nom: '', age_mois: null, date_naissance: null, sexe: null, reserve: true, date_publication: null }));
    assert.equal(d.nom, '(sans nom)');
    assert.equal(d.age, 'âge inconnu');
    assert.equal(d.sexe, null);
    assert.equal(d.reserve, 'réservé·e');
    assert.equal(d.publication, null);
  });

  test('âge < 1 mois : en semaines avec date de naissance, « moins d\'un mois » sinon', () => {
    assert.equal(describe(annonceSpa({ age_mois: 0.7, date_naissance: '2026-09-03' })).age, '3 semaines (né·e le 03/09/2026)');
    assert.equal(describe(annonceSpa({ age_mois: 0.7, date_naissance: null })).age, "moins d'un mois");
  });
});

// =============================================================================================
// buildReport()
// =============================================================================================

suite('buildReport() — rapport Markdown / texte / HTML / JSON', () => {
  test('titre daté dans le fuseau configuré (Europe/Paris)', () => {
    assert.equal(rapport().titre, 'Annonces chatons — jeudi 24 septembre 2026');
    // 23:30 UTC le 24 = 01:30 le 25 à Paris.
    assert.equal(rapport({ now: TARD_LE_SOIR }).titre, 'Annonces chatons — vendredi 25 septembre 2026');
  });

  test('sections et comptes : un chaton aussi nouvel arrivant n\'est compté qu\'une fois dans « nouveaux »', () => {
    const chaton1 = annonceSpa();
    const chaton2 = annonceSc({ id: 'secondechance:2', nom: 'Mimi', age_mois: 3 });
    const adulte = annonceSpa({ id: 'laspa:2002', nom: 'Gros Minet', age_mois: 48, date_naissance: null });
    const adulte2 = annonceSc({ id: 'secondechance:3', nom: 'Félix', age_mois: 30, date_naissance: null });
    const r = rapport({ kittens: [chaton1, chaton2], newcomers: [chaton1, adulte, adulte2] });

    assert.deepEqual(r.compte, { chatons: 2, nouveaux: 2 });
    assert.match(r.markdown, /^## 🐾 Chatons de moins de 4 mois \(2\)$/m);
    assert.match(r.markdown, /^## 🆕 Nouveaux arrivants \(mis en ligne depuis 7 jours ou jamais vus\) \(2\)$/m);
    assert.match(r.text, /^🐾 CHATONS DE MOINS DE 4 MOIS \(2\)$/m);
    assert.match(r.html, /^<b>🆕 Nouveaux arrivants \(mis en ligne depuis 7 jours ou jamais vus\) \(2\)<\/b>$/m);

    // Ella (chaton ET nouvelle) n'apparaît qu'une fois ; les adultes sont dans la 2e section.
    assert.equal(r.markdown.match(/\*\*\[Ella\]/g).length, 1);
    const [avant, apres] = r.markdown.split('## 🆕');
    assert.match(avant, /\[Mimi\]/);
    assert.match(apres, /\[Gros Minet\]/);
    assert.match(apres, /\[Félix\]/);
    // Le JSON garde la liste complète des nouveaux arrivants.
    assert.equal(r.json.nouveaux_arrivants.length, 3);
    assert.equal(r.json.chatons.length, 2);
  });

  test('note « aussi des nouveaux arrivants » dans les trois formats, seulement si un chaton est aussi nouveau', () => {
    const chaton = annonceSpa();
    const tigrou = annonceSc({ id: 'secondechance:9', nom: 'Tigrou' });
    const r = rapport({ kittens: [chaton], newcomers: [chaton, tigrou] });
    const note = '1 chaton(s) ci-dessus sont aussi des nouveaux arrivants.';
    assert.ok(r.markdown.includes(`_${note}_`));
    assert.ok(r.text.includes(`  ${note}`));
    assert.ok(r.html.includes(`<i>${note}</i>`));

    const sansRecoupement = rapport({ kittens: [chaton], newcomers: [tigrou] });
    for (const format of [sansRecoupement.markdown, sansRecoupement.text, sansRecoupement.html]) {
      assert.doesNotMatch(format, /aussi des nouveaux arrivants/);
    }
  });

  test('sections vides : messages dédiés et comptes à zéro', () => {
    const r = rapport();
    assert.deepEqual(r.compte, { chatons: 0, nouveaux: 0 });
    assert.match(r.markdown, /## 🐾 Chatons de moins de 4 mois \(0\)\n\n_Aucun chaton correspondant aujourd'hui\._/);
    assert.match(r.markdown, /\(0\)\n\n_Aucun nouvel arrivant\._/);
    assert.ok(r.text.includes("  Aucun chaton correspondant aujourd'hui."));
    assert.ok(r.html.includes("<i>Aucun chaton correspondant aujourd'hui.</i>"));
  });

  test('libellé du critère « nouveaux arrivants » selon la configuration', () => {
    const parDate = rapport({ config: configRapport({ age_max_mois: 6, nouveaux_arrivants: { critere: 'date_publication', jours: 1 } }) });
    assert.match(parDate.markdown, /## 🐾 Chatons de moins de 6 mois \(0\)/);
    assert.match(parDate.markdown, /## 🆕 Nouveaux arrivants \(mis en ligne depuis 1 jour\) \(0\)/);
    const jamaisVus = rapport({ config: configRapport({ nouveaux_arrivants: { critere: 'premiere_vue' } }) });
    assert.match(jamaisVus.markdown, /## 🆕 Nouveaux arrivants \(jamais vus par le bot\) \(0\)/);
  });

  test('section « Avertissements » présente seulement s\'il y a des erreurs', () => {
    const sans = rapport();
    assert.doesNotMatch(sans.markdown, /Avertissements/);
    assert.doesNotMatch(sans.text, /AVERTISSEMENTS/);
    assert.doesNotMatch(sans.html, /Avertissements/);

    const avec = rapport({ errors: ['Source laspa indisponible : HTTP 503', 'secondechance : 2 fiche(s) non lue(s).'] });
    assert.match(avec.markdown, /## ⚠️ Avertissements\n\n- Source laspa indisponible : HTTP 503\n- secondechance : 2 fiche\(s\) non lue\(s\)\./);
    assert.match(avec.text, /⚠️ AVERTISSEMENTS\n {2}- Source laspa indisponible : HTTP 503/);
    assert.match(avec.html, /<b>⚠️ Avertissements<\/b>\n- Source laspa indisponible : HTTP 503/);
    assert.deepEqual(avec.json.erreurs, ['Source laspa indisponible : HTTP 503', 'secondechance : 2 fiche(s) non lue(s).']);
  });

  test('HTML Telegram : <, & et > échappés (nom, race, lieu, URL, avertissements)', () => {
    const l = annonceSpa({
      nom: 'Tom & <Jerry>',
      race: 'Européen <croisé>',
      url: 'https://www.la-spa.fr/adoption/?id=1&ref=<x>',
      lieu: { nom: 'Refuge Chats & Co', ville: 'Gennevilliers' },
    });
    const r = rapport({ kittens: [l], errors: ['Réponse <html> inattendue & tronquée'] });
    assert.ok(r.html.includes('<a href="https://www.la-spa.fr/adoption/?id=1&amp;ref=&lt;x&gt;"><b>Tom &amp; &lt;Jerry&gt;</b></a>'));
    assert.ok(r.html.includes('Européen &lt;croisé&gt;'));
    assert.ok(r.html.includes('📍 Refuge Chats &amp; Co · Gennevilliers (92) · 11 km'));
    assert.ok(r.html.includes('- Réponse &lt;html&gt; inattendue &amp; tronquée'));
    assert.ok(!r.html.includes('<Jerry>'));
    assert.ok(!r.html.includes('<html>'));
    // Seules les balises prises en charge par Telegram subsistent.
    const balises = new Set([...r.html.matchAll(/<\/?([a-z]+)[\s>]/g)].map((m) => m[1]));
    assert.deepEqual([...balises].sort(), ['a', 'b', 'i']);
  });

  test('pied de page : zone, sources actives seulement, nombre de requêtes HTTP', () => {
    const r = rapport({ stats: { requests: 42 } });
    assert.ok(r.markdown.includes('_Zone : 50 km autour de Paris · Sources : La SPA + Seconde Chance · 42 requêtes HTTP_'));
    assert.ok(r.text.includes('Zone : 50 km autour de Paris · Sources : La SPA + Seconde Chance · 42 requêtes HTTP'));

    const spaSeule = rapport({ config: configRapport({ sources: { secondechance: { actif: false } } }) });
    assert.ok(spaSeule.markdown.includes('_Zone : 50 km autour de Paris · Sources : La SPA_'));
    assert.doesNotMatch(spaSeule.markdown, /requêtes HTTP/);
  });

  test('Markdown et texte : ligne de l\'annonce, lieu, date de mise en ligne et URL', () => {
    const r = rapport({ kittens: [annonceSpa()] });
    assert.ok(r.markdown.includes(
      '- **[Ella](https://www.la-spa.fr/adoption/chats/ella-1001/)** — 2 mois (né·e le 01/07/2026) · ♀ femelle · Européen\n'
      + '  📍 La SPA - Refuge de Gennevilliers – Grammont · 11 km\n'
      + '  🗓 mis en ligne le 21/09/2026 · La SPA',
    ));
    assert.ok(r.text.includes('• Ella — 2 mois (né·e le 01/07/2026) · ♀ femelle · Européen'));
    assert.ok(r.text.includes('    https://www.la-spa.fr/adoption/chats/ella-1001/'));
  });

  test('JSON : date ISO, zone, paramètres, champs internes (_now) retirés', () => {
    const chaton = annonceSpa();
    const r = rapport({ kittens: [chaton], newcomers: [chaton], stats: { requests: 3 } });
    assert.equal(r.json.date, '2026-09-24T06:00:00.000Z');
    assert.deepEqual(r.json.zone, {
      mode: 'rayon', label: '50 km autour de Paris', centre: { latitude: 48.857, longitude: 2.352 }, rayon_km: 50, departements: [],
    });
    assert.equal(r.json.parametres.age_max_mois, 4);
    assert.equal(r.json.parametres.inclure_reserves, false);
    assert.equal(r.json.chatons[0].nom, 'Ella');
    assert.ok(!('_now' in r.json.chatons[0]));
    assert.ok(!('_now' in r.json.nouveaux_arrivants[0]));
    assert.ok('_now' in chaton, 'l\'annonce d\'origine ne doit pas être modifiée');
    assert.deepEqual(r.json.stats, { requests: 3 });
    // Sérialisable tel quel (écrit par notifyFile).
    assert.doesNotThrow(() => JSON.stringify(r.json));
  });
});

// =============================================================================================
// chunkText()
// =============================================================================================

suite('chunkText() — découpe des messages', () => {
  test('texte court : un seul morceau identique ; texte vide : aucun morceau', () => {
    assert.deepEqual(chunkText('ligne 1\nligne 2', 100), ['ligne 1\nligne 2']);
    assert.deepEqual(chunkText('', 100), []);
  });

  test('découpe en morceaux ≤ limite sans couper les lignes', () => {
    const lignes = Array.from({ length: 20 }, (_, i) => `ligne ${String(i).padStart(2, '0')} ${'x'.repeat(20)}`); // 29 car.
    const texte = lignes.join('\n');
    const morceaux = chunkText(texte, 100);
    assert.ok(morceaux.length > 1);
    for (const m of morceaux) {
      assert.ok(m.length <= 100, `morceau de ${m.length} caractères`);
      for (const ligne of m.split('\n')) assert.ok(lignes.includes(ligne), `ligne coupée : ${ligne}`);
    }
    // Rien n'est perdu ni dupliqué.
    assert.equal(morceaux.join('\n'), texte);
    // Chaque morceau est rempli au maximum (3 lignes de 29 car. + 2 sauts = 89 ≤ 100 < 119).
    assert.equal(morceaux[0].split('\n').length, 3);
  });

  test('une ligne plus longue que la limite est tronquée avec « … »', () => {
    const longue = 'y'.repeat(250);
    const morceaux = chunkText(`début\n${longue}\nfin`, 100);
    assert.deepEqual(morceaux, ['début', `${'y'.repeat(99)}…`, 'fin']);
    for (const m of morceaux) assert.ok(m.length <= 100);
  });

  test('limite par défaut : 2000 caractères (Discord)', () => {
    const texte = Array.from({ length: 100 }, () => 'z'.repeat(49)).join('\n'); // 100 × 50 = 5000 car.
    const morceaux = chunkText(texte);
    assert.equal(morceaux.length, 3);
    for (const m of morceaux) assert.ok(m.length <= 2000);
  });
});

// =============================================================================================
// Discord
// =============================================================================================

suite('notifyDiscord()', () => {
  test('webhook manquant : erreur explicite, aucune requête', async () => {
    const { fetchImpl, appels } = fauxFetch();
    await assert.rejects(notifyDiscord({ markdown: 'x' }, { fetchImpl }), /Discord : webhook_url manquant/);
    assert.equal(appels.length, 0);
  });

  test('POST JSON sur le webhook avec le rapport Markdown', async () => {
    const { fetchImpl, appels } = fauxFetch();
    const r = rapport({ kittens: [annonceSpa()] });
    const res = await notifyDiscord(r, { webhook_url: WEBHOOK, userAgent: 'test-ua/1.0', fetchImpl });
    assert.deepEqual(res, { canal: 'discord', ok: true, messages: 1 });
    assert.equal(appels.length, 1);
    assert.equal(appels[0].url, WEBHOOK);
    assert.equal(appels[0].init.method, 'POST');
    assert.equal(appels[0].init.headers['content-type'], 'application/json');
    assert.equal(appels[0].init.headers['user-agent'], 'test-ua/1.0');
    assert.deepEqual(appels[0].corps, { content: r.markdown, username: 'Annonces chatons' });
  });

  test('rapport long : plusieurs messages ≤ 2000 caractères, dans l\'ordre', async () => {
    const { fetchImpl, appels } = fauxFetch();
    const markdown = Array.from({ length: 60 }, (_, i) => `- chaton n°${String(i).padStart(2, '0')} ${'m'.repeat(40)}`).join('\n'); // ≈ 3000 car.
    const res = await notifyDiscord({ markdown }, { webhook_url: WEBHOOK, fetchImpl });
    assert.equal(res.messages, 2);
    assert.equal(appels.length, 2);
    for (const a of appels) assert.ok(a.corps.content.length <= 2000);
    assert.equal(appels.map((a) => a.corps.content).join('\n'), markdown);
  });

  test('réponse HTTP 404 (webhook supprimé) : erreur, sans nouvelle tentative', async () => {
    const { fetchImpl, appels } = fauxFetch(() => new Response('{"message": "Unknown Webhook"}', { status: 404 }));
    await assert.rejects(notifyDiscord({ markdown: 'x' }, { webhook_url: WEBHOOK, fetchImpl }), /HTTP 404/);
    assert.equal(appels.length, 1);
  });
});

// =============================================================================================
// Telegram
// =============================================================================================

suite('notifyTelegram()', () => {
  test('jeton ou chat_id manquant : erreur explicite, aucune requête', async () => {
    const { fetchImpl, appels } = fauxFetch(reponseTelegramOk);
    await assert.rejects(notifyTelegram({ html: 'x' }, { bot_token: BOT_TOKEN, fetchImpl }), /bot_token ou chat_id manquant/);
    await assert.rejects(notifyTelegram({ html: 'x' }, { chat_id: '42', fetchImpl }), /bot_token ou chat_id manquant/);
    assert.equal(appels.length, 0);
  });

  test('sendMessage : bon endpoint, HTML, aperçu des liens désactivé', async () => {
    const { fetchImpl, appels } = fauxFetch(reponseTelegramOk);
    const r = rapport({ kittens: [annonceSpa()] });
    const res = await notifyTelegram(r, { bot_token: BOT_TOKEN, chat_id: '-100123', fetchImpl });
    assert.deepEqual(res, { canal: 'telegram', ok: true, messages: 1 });
    assert.equal(appels.length, 1);
    assert.equal(appels[0].url, `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    assert.equal(appels[0].init.method, 'POST');
    assert.deepEqual(appels[0].corps, { chat_id: '-100123', text: r.html, parse_mode: 'HTML', disable_web_page_preview: true });
  });

  test('rapport long : plusieurs messages ≤ 4096 caractères, balises équilibrées dans chacun', async () => {
    const { fetchImpl, appels } = fauxFetch(reponseTelegramOk);
    const chatons = Array.from({ length: 40 }, (_, i) => annonceSpa({
      id: `laspa:${3000 + i}`, nom: `Chaton & <${i}>`, url: `https://www.la-spa.fr/adoption/chats/chaton-${3000 + i}/?a=1&b=2`,
    }));
    const r = rapport({ kittens: chatons });
    assert.ok(r.html.length > 4096, `html de ${r.html.length} caractères`);

    const res = await notifyTelegram(r, { bot_token: BOT_TOKEN, chat_id: '42', fetchImpl });
    assert.equal(res.messages, appels.length);
    assert.ok(appels.length >= 2);
    for (const { corps } of appels) {
      assert.ok(corps.text.length <= 4096);
      for (const b of ['a', 'b', 'i']) {
        const ouvrantes = (corps.text.match(new RegExp(`<${b}[ >]`, 'g')) ?? []).length;
        const fermantes = (corps.text.match(new RegExp(`</${b}>`, 'g')) ?? []).length;
        assert.equal(ouvrantes, fermantes, `<${b}> déséquilibrée dans un message`);
      }
    }
    assert.equal(appels.map((a) => a.corps.text).join('\n'), r.html);
  });

  test('réponse { ok: false } : erreur avec la description de Telegram', async () => {
    const { fetchImpl } = fauxFetch(() => new Response(
      JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await assert.rejects(
      notifyTelegram({ html: 'bonjour' }, { bot_token: BOT_TOKEN, chat_id: '42', fetchImpl }),
      { message: 'Telegram : Bad Request: chat not found' },
    );
  });

  test('erreur HTTP de l\'API (400) : l\'erreur remonte', async () => {
    const { fetchImpl, appels } = fauxFetch(() => new Response(
      JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }), { status: 400 },
    ));
    await assert.rejects(notifyTelegram({ html: 'bonjour' }, { bot_token: BOT_TOKEN, chat_id: '42', fetchImpl }), /400/);
    assert.equal(appels.length, 1);
  });
});

// =============================================================================================
// Fichier
// =============================================================================================

suite('notifyFile()', () => {
  test('écrit AAAA-MM-JJ.md / .json et latest.md / latest.json', async () => {
    const dossier = path.join(dossierTemp(), 'reports', 'sous-dossier'); // créé récursivement
    const r = rapport({ kittens: [annonceSpa()] });
    const res = await notifyFile(r, { dossier, now: MAINTENANT, fuseau: 'Europe/Paris' });

    assert.deepEqual(res, {
      canal: 'fichier', ok: true,
      fichiers: [path.join(dossier, '2026-09-24.md'), path.join(dossier, '2026-09-24.json')],
    });
    assert.deepEqual(readdirSync(dossier).sort(), ['2026-09-24.json', '2026-09-24.md', 'latest.json', 'latest.md']);
    assert.equal(readFileSync(path.join(dossier, '2026-09-24.md'), 'utf8'), r.markdown);
    assert.equal(readFileSync(path.join(dossier, 'latest.md'), 'utf8'), r.markdown);
    const json = JSON.parse(readFileSync(path.join(dossier, '2026-09-24.json'), 'utf8'));
    assert.deepEqual(json, JSON.parse(JSON.stringify(r.json)));
    assert.deepEqual(JSON.parse(readFileSync(path.join(dossier, 'latest.json'), 'utf8')), json);
  });

  test('le nom du fichier suit la date locale du fuseau (pas la date UTC)', async () => {
    assert.equal(localDate(TARD_LE_SOIR, 'Europe/Paris'), '2026-09-25');
    assert.equal(localDate(TARD_LE_SOIR, 'UTC'), '2026-09-24');
    const dossier = dossierTemp();
    await notifyFile(rapport({ now: TARD_LE_SOIR }), { dossier, now: TARD_LE_SOIR, fuseau: 'Europe/Paris' });
    assert.ok(existsSync(path.join(dossier, '2026-09-25.md')));
    assert.ok(!existsSync(path.join(dossier, '2026-09-24.md')));
  });

  test('un second rapport du même jour remplace le précédent et met à jour latest.*', async () => {
    const dossier = dossierTemp();
    await notifyFile(rapport(), { dossier, now: MAINTENANT });
    const r2 = rapport({ kittens: [annonceSpa()] });
    await notifyFile(r2, { dossier, now: MAINTENANT });
    assert.equal(readdirSync(dossier).length, 4);
    assert.equal(readFileSync(path.join(dossier, '2026-09-24.md'), 'utf8'), r2.markdown);
    assert.equal(readFileSync(path.join(dossier, 'latest.md'), 'utf8'), r2.markdown);
  });
});

// =============================================================================================
// notifyAll()
// =============================================================================================

/** Remplace process.stdout.write le temps d'un test : capture le rapport, laisse passer le reste. */
function capturerStdout(t, marqueur) {
  const original = process.stdout.write.bind(process.stdout);
  const captures = [];
  t.mock.method(process.stdout, 'write', (chunk, ...rest) => {
    if (typeof chunk === 'string' && chunk.includes(marqueur)) { captures.push(chunk); return true; }
    return original(chunk, ...rest);
  });
  return captures;
}

function configNotifs(notifications, over = {}) {
  return configRapport({ notifications, ...over });
}

suite('notifyAll()', () => {
  test('un canal en échec n\'empêche pas les autres (fichier, Discord en 404, Telegram)', async () => {
    const dossier = dossierTemp();
    const { fetchImpl, appels } = fauxFetch((url) => (url.startsWith('https://discord.com/')
      ? new Response('{"message": "Unknown Webhook"}', { status: 404 })
      : reponseTelegramOk()));
    const journal = [];
    const config = configNotifs({
      console: false,
      fichier: { actif: true, dossier },
      discord: { actif: true, webhook_url: WEBHOOK },
      telegram: { actif: true, bot_token: BOT_TOKEN, chat_id: '42' },
    });
    const r = rapport({ kittens: [annonceSpa()] });

    const res = await notifyAll(r, config, { now: MAINTENANT, fetchImpl, log: (m) => journal.push(m) });

    assert.deepEqual(res.map(({ canal, ok }) => ({ canal, ok })), [
      { canal: 'fichier', ok: true },
      { canal: 'discord', ok: false },
      { canal: 'telegram', ok: true },
    ]);
    assert.match(res[1].erreur, /HTTP 404/);
    assert.ok(existsSync(path.join(dossier, '2026-09-24.md')));
    assert.deepEqual(appels.map((a) => a.url), [WEBHOOK, `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`]);
    assert.ok(journal.includes('Notification fichier : OK'));
    assert.ok(journal.some((m) => m.startsWith('Notification discord : ÉCHEC — HTTP 404')));
    assert.ok(journal.includes('Notification telegram : OK'));
  });

  test('canal actif mal configuré (webhook absent) : échec isolé, les suivants partent', async () => {
    const { fetchImpl, appels } = fauxFetch(reponseTelegramOk);
    const config = configNotifs({
      console: false,
      fichier: { actif: false },
      discord: { actif: true, webhook_url: '' },
      telegram: { actif: true, bot_token: BOT_TOKEN, chat_id: '42' },
    });
    const res = await notifyAll(rapport(), config, { now: MAINTENANT, fetchImpl });
    assert.deepEqual(res, [
      { canal: 'discord', ok: false, erreur: 'Discord : webhook_url manquant' },
      { canal: 'telegram', ok: true, messages: 1 },
    ]);
    assert.equal(appels.length, 1);
  });

  test('dryRun : console seulement, aucun fichier écrit ni message envoyé', async (t) => {
    const dossier = path.join(dossierTemp(), 'reports-dry-run');
    const { fetchImpl, appels } = fauxFetch(reponseTelegramOk);
    const config = configNotifs({
      console: true,
      fichier: { actif: true, dossier },
      discord: { actif: true, webhook_url: WEBHOOK },
      telegram: { actif: true, bot_token: BOT_TOKEN, chat_id: '42' },
    });
    const r = rapport({ kittens: [annonceSpa()] });
    const journal = [];
    const sortie = capturerStdout(t, r.titre);

    const res = await notifyAll(r, config, { now: MAINTENANT, dryRun: true, fetchImpl, log: (m) => journal.push(m) });

    assert.deepEqual(res, [{ canal: 'console', ok: true }]);
    assert.deepEqual(sortie, [`${r.text}\n`]);
    assert.equal(existsSync(dossier), false);
    assert.equal(appels.length, 0);
    assert.ok(journal.some((m) => m.includes('--dry-run')));
  });

  test('console active par défaut ; aucun autre canal sans configuration', async (t) => {
    const r = rapport();
    const sortie = capturerStdout(t, r.titre);
    const res = await notifyAll(r, { notifications: {} }, { now: MAINTENANT });
    assert.deepEqual(res, [{ canal: 'console', ok: true }]);
    assert.equal(sortie.length, 1);
  });

  test('les erreurs journalisées ne divulguent ni le jeton Telegram ni l\'URL secrète du webhook Discord', {
    todo: 'bug: postJson (src/http.js:134) met l\'URL complète (jeton du bot / jeton du webhook) dans le message d\'erreur, journalisé par notifyAll (src/notify/index.js:19)',
  }, async () => {
    const { fetchImpl } = fauxFetch((url) => (url.startsWith('https://discord.com/')
      ? new Response('{"message": "Unknown Webhook"}', { status: 404 })
      : new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), { status: 401 })));
    const journal = [];
    const config = configNotifs({
      console: false,
      fichier: { actif: false },
      discord: { actif: true, webhook_url: WEBHOOK },
      telegram: { actif: true, bot_token: BOT_TOKEN, chat_id: '42' },
    });
    const res = await notifyAll(rapport(), config, { now: MAINTENANT, fetchImpl, log: (m) => journal.push(m) });

    assert.deepEqual(res.map((x) => x.ok), [false, false]);
    for (const texte of [...res.map((x) => x.erreur), ...journal]) {
      assert.ok(!texte.includes(BOT_TOKEN), `jeton Telegram divulgué : ${texte}`);
      assert.ok(!texte.includes('secret-webhook-token'), `jeton du webhook Discord divulgué : ${texte}`);
    }
  });
});
