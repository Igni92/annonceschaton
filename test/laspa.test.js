// Tests de src/sources/laspa.js (API JSON de la-spa.fr).
// Données : copies de réponses réelles dans test/fixtures/laspa_*.json.
// Aucun accès réseau : fetchLaSpa reçoit un faux client http ({ getJson, getText }) qui route selon l'URL ;
// « maintenant » est toujours figé.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  LASPA_BASE,
  LASPA_SITE,
  applyFiche,
  fetchLaSpa,
  mapEstablishments,
  mapSearchResult,
  parseFiche,
} from '../src/sources/laspa.js';
import { buildZone } from '../src/filters.js';
import { haversineKm } from '../src/geo.js';
import { emptyState } from '../src/state.js';

// ---------------------------------------------------------------------------
// Fixtures et utilitaires
// ---------------------------------------------------------------------------

const lireFixture = (nom) => JSON.parse(readFileSync(new URL(`./fixtures/${nom}`, import.meta.url), 'utf8'));
const ESTABLISHMENTS = lireFixture('laspa_establishments.json');
const SEARCH = lireFixture('laspa_search.json');
const FICHE = lireFixture('laspa_fiche.json');

const clone = (v) => structuredClone(v);
const NOW = new Date('2026-09-24T12:00:00Z');
const PARIS = { latitude: 48.857, longitude: 2.352 };
const MONT_DE_MARSAN = { latitude: 43.856085, longitude: -0.544466 }; // coordonnées du refuge 7373

/** Âge en mois pour un nombre de jours (même convention que src/age.js : 365,25 / 12 jours par mois). */
const mois = (jours) => jours / (365.25 / 12);
const presque = (actuel, attendu, msg) => assert.ok(Math.abs(actuel - attendu) < 1e-9, `${msg ?? ''} ${actuel} ≠ ${attendu}`);

/** Élément de la recherche par nom (ELLA, Brume, VICKY, MINERVA QCT, PERLE ( réservée ), Marley). */
function item(nom) {
  const it = SEARCH.results.find((r) => r.name.startsWith(nom));
  assert.ok(it, `élément ${nom} absent de la fixture`);
  return clone(it);
}
const ELLA = item('ELLA');           // junior, N/A, refuge inconnu des établissements
const BRUME = item('Brume');         // junior, N/A, sos, description HTML
const VICKY = item('VICKY');         // junior, « 1 an »
const MINERVA = item('MINERVA');     // junior, « 1 an »
const PERLE = item('PERLE');         // junior, N/A, « ( réservée ) »
const MARLEY = item('Marley');       // junior, « 1 an », refuge de Mont-de-Marsan (présent dans les établissements)

const ETABS = mapEstablishments(ESTABLISHMENTS);

/** Fiche détaillée réelle dont on remplace la date de naissance. */
function ficheAvec(birthday) {
  const f = clone(FICHE);
  f.content.infos.birthday = birthday;
  return f;
}

/** Deux pages de recherche (nb_pages = 2) ; ELLA réapparaît en page 2 (doublon). */
function deuxPages() {
  return [
    { total: 6, nb_pages: 2, results: [ELLA, BRUME, VICKY] },
    { total: 6, nb_pages: 2, results: [MINERVA, PERLE, MARLEY, ELLA] },
  ];
}

/** Fiches des trois junior « N/A ». */
function fichesJunior() {
  return {
    'animal-ella': ficheAvec('Né(e) le 2026-07-01'),
    'animal-brume-7': ficheAvec('Né(e) le 2026-05-10'),
    'animal-perle-9': ficheAvec('Né(e) le 2026-08-15'),
  };
}

/**
 * Faux client http : route establishments / animals/search / posts, mémorise les URL demandées.
 * `pages` : tableau (index paged-1) ou fonction (paged) → json.
 * `fiches` : { uid: json | Error }.
 */
function fauxHttp({ pages = deuxPages(), fiches = fichesJunior(), establishments = ESTABLISHMENTS } = {}) {
  const appels = [];
  return {
    appels,
    get recherches() { return appels.filter((u) => u.includes('/animals/search/')).map((u) => new URL(u)); },
    get fiches() { return appels.filter((u) => u.includes('/posts/')).map((u) => new URL(u).searchParams.get('_uid')); },
    async getJson(url) {
      appels.push(url);
      const u = new URL(url);
      if (u.pathname.endsWith('/establishments/')) return clone(establishments);
      if (u.pathname.endsWith('/animals/search/')) {
        const paged = Number(u.searchParams.get('paged'));
        const json = typeof pages === 'function' ? pages(paged) : pages[paged - 1];
        if (!json) throw new Error(`page ${paged} inattendue`);
        return clone(json);
      }
      if (u.pathname.endsWith('/posts/')) {
        const f = fiches[u.searchParams.get('_uid')];
        if (f instanceof Error) throw f;
        if (!f) throw new Error(`fiche ${u.searchParams.get('_uid')} inattendue`);
        return clone(f);
      }
      throw new Error(`URL inattendue : ${url}`);
    },
    async getText(url) {
      appels.push(url);
      throw new Error('getText ne devrait pas être appelé par la source La SPA');
    },
  };
}

/** Fausse zone : mémorise les annonces soumises à inZone. */
function fausseZone({ mode = 'france', centre = null, rayon_km = 0, accepte = () => true } = {}) {
  const soumises = [];
  return {
    mode, centre, rayon_km, departements: [], soumises,
    inZone(l) { soumises.push({ id: l.id, distance_km: l.lieu.distance_km }); return accepte(l); },
  };
}

const CONFIG = { zone: { mode: 'france' } };
const parId = (listings) => Object.fromEntries(listings.map((l) => [l.id, l]));

// ---------------------------------------------------------------------------
// mapEstablishments
// ---------------------------------------------------------------------------

describe('mapEstablishments', () => {
  test('indexe les 6 établissements par le slug extrait de leur URL', () => {
    assert.equal(ETABS.size, 6);
    assert.deepEqual([...ETABS.keys()].sort(), [
      'club-jeunes-de-saint-pierre-du-mont',
      'club-jeunes-dorgeval',
      'refuge-spa-de-gennevilliers-grammont',
      'refuge-spa-de-marennes-lyon',
      'refuge-spa-de-saint-pierre-du-mont-mont-de-marsan',
      'refuge-spa-dorgeval',
    ]);
  });

  test('extrait code postal, département, ville, adresse lisible et URL complète (Gennevilliers)', () => {
    const g = ETABS.get('refuge-spa-de-gennevilliers-grammont');
    assert.equal(g.id, '7403');
    assert.equal(g.slug, 'refuge-spa-de-gennevilliers-grammont');
    assert.equal(g.nom, 'La SPA - Refuge de Gennevilliers – Grammont');
    assert.equal(g.type, 'Refuges');
    assert.equal(g.code_postal, '92230');
    assert.equal(g.departement, '92');
    assert.equal(g.ville, 'Gennevilliers');
    assert.equal(g.adresse, '121 Av. Marcel Paul 117 119, 92230 Gennevilliers');
    assert.equal(g.url, `${LASPA_SITE}/etablissement/refuge-spa-de-gennevilliers-grammont/`);
  });

  test('convertit les coordonnées texte en nombres', () => {
    const g = ETABS.get('refuge-spa-de-gennevilliers-grammont');
    assert.equal(g.latitude, 48.944706567958);
    assert.equal(g.longitude, 2.3035848619018);
    const m = ETABS.get('refuge-spa-de-saint-pierre-du-mont-mont-de-marsan');
    assert.equal(m.latitude, 43.856085);
    assert.equal(m.longitude, -0.544466);
  });

  test('garde la ville quand la rue contient une virgule (Saint-Pierre Du Mont, 40)', () => {
    const c = ETABS.get('club-jeunes-de-saint-pierre-du-mont');
    assert.equal(c.ville, 'Saint-Pierre Du Mont');
    assert.equal(c.code_postal, '40280');
    assert.equal(c.departement, '40');
    assert.equal(c.type, 'Clubs jeunes');
    assert.equal(ETABS.get('refuge-spa-de-marennes-lyon').departement, '69');
    assert.equal(ETABS.get('refuge-spa-dorgeval').departement, '78');
  });

  test('ignore les éléments sans URL « /etablissement/<slug>/ » et tolère une réponse vide', () => {
    const map = mapEstablishments({
      items: [
        { ID: 1, name: 'Sans URL', address: 'rue<br>75011 Paris' },
        { ID: 2, name: 'Autre URL', url: '/refuge/xyz/', address: 'rue<br>75011 Paris' },
        { ID: 3, name: 'OK', url: '/etablissement/ok/', address: 'rue<br>75011 Paris', latitude: '48.8', longitude: '2.3' },
      ],
    });
    assert.deepEqual([...map.keys()], ['ok']);
    assert.equal(mapEstablishments(null).size, 0);
    assert.equal(mapEstablishments({}).size, 0);
  });

  test('coordonnées absentes (null ou "") → null, pas (0, 0)', () => {
    const map = mapEstablishments({
      items: [{ ID: 9, name: 'Refuge X', url: '/etablissement/x/', address: 'rue<br>75011 Paris', latitude: null, longitude: '' }],
    });
    const x = map.get('x');
    assert.equal(x.latitude, null);
    assert.equal(x.longitude, null);
  });
});

// ---------------------------------------------------------------------------
// mapSearchResult
// ---------------------------------------------------------------------------

describe('mapSearchResult', () => {
  test('identifiants : id « laspa:<ID> », source, uid, URL complète et image', () => {
    const l = mapSearchResult(ELLA, ETABS, NOW);
    assert.equal(l.id, 'laspa:244109');
    assert.equal(l.source, 'laspa');
    assert.equal(l.source_label, 'La SPA');
    assert.equal(l.source_id, '244109');
    assert.equal(l.uid, 'animal-ella');
    assert.equal(l.nom, 'ELLA');
    assert.equal(l.url, 'https://www.la-spa.fr/animal/ella/');
    assert.match(l.image, /ella-244109/);
    assert.equal(l.espece, 'chat');
    assert.equal(l.fiche_lue, false);
    assert.equal(l.date_naissance, null);
  });

  test('détecte « réservée » dans le nom (réservé), quelles que soient casse et accents', () => {
    assert.equal(mapSearchResult(PERLE, ETABS, NOW).reserve, true);
    assert.equal(mapSearchResult(ELLA, ETABS, NOW).reserve, false);
    for (const name of ['MINOU (RÉSERVÉE)', 'Tigrou réservé', 'Chipie - reservee']) {
      assert.equal(mapSearchResult({ ...ELLA, name }, ETABS, NOW).reserve, true, name);
    }
    assert.equal(mapSearchResult({ ...ELLA, name: 'Réservation possible' }, ETABS, NOW).reserve, false);
  });

  test('âge « N/A » → age_mois et age_texte null ; « 1 an » → 12 mois', () => {
    const ella = mapSearchResult(ELLA, ETABS, NOW);
    assert.equal(ella.age_mois, null);
    assert.equal(ella.age_texte, null);
    assert.equal(ella.age_categorie, 'junior');
    const vicky = mapSearchResult(VICKY, ETABS, NOW);
    assert.equal(vicky.age_texte, '1 an');
    assert.equal(vicky.age_mois, 12);
  });

  test('date_publication = partie « YYYY-MM-DD » de created_at (heure de Paris)', () => {
    assert.equal(mapSearchResult(ELLA, ETABS, NOW).date_publication, '2026-09-24');
    assert.equal(mapSearchResult(MARLEY, ETABS, NOW).date_publication, '2026-09-21');
    assert.equal(mapSearchResult({ ...ELLA, created_at: undefined }, ETABS, NOW).date_publication, null);
  });

  test('lieu complété depuis l’établissement connu (Marley, refuge de Mont-de-Marsan)', () => {
    const l = mapSearchResult(MARLEY, ETABS, NOW);
    assert.deepEqual(l.lieu, {
      nom: 'La SPA - Refuge de Saint-Pierre-du-Mont – Mont-de-Marsan',
      slug: 'refuge-spa-de-saint-pierre-du-mont-mont-de-marsan',
      ville: 'Saint-Pierre-Du-Mont',
      code_postal: '40280',
      departement: '40',
      latitude: 43.856085,
      longitude: -0.544466,
      precision: 'exacte',
      distance_km: null,
      url: `${LASPA_SITE}/etablissement/refuge-spa-de-saint-pierre-du-mont-mont-de-marsan/`,
    });
  });

  test('établissement absent de la liste : nom et URL repris de l’annonce, précision « inconnue »', () => {
    const l = mapSearchResult(ELLA, ETABS, NOW);
    assert.equal(l.lieu.nom, 'La SPA - Refuge de Poulainville');
    assert.equal(l.lieu.slug, 'refuge-spa-de-poulainville');
    assert.equal(l.lieu.url, `${LASPA_SITE}/etablissement/refuge-spa-de-poulainville/`);
    assert.equal(l.lieu.latitude, null);
    assert.equal(l.lieu.departement, null);
    assert.equal(l.lieu.precision, 'inconnue');
  });

  test('sexe normalisé, race, drapeaux sos/fad et description sans balises', () => {
    const brume = mapSearchResult(BRUME, ETABS, NOW);
    assert.equal(brume.sexe, 'femelle');
    assert.equal(brume.race, 'Europeen');
    assert.equal(brume.sos, true);
    assert.equal(brume.fad, false);
    assert.doesNotMatch(brume.description, /<br/);
    assert.match(brume.description, /Brume est une chatonne/);
    assert.ok(brume.description.length <= 400);
    assert.equal(mapSearchResult(MARLEY, ETABS, NOW).sexe, 'male');
    assert.equal(mapSearchResult(PERLE, ETABS, NOW).description, null);
  });
});

// ---------------------------------------------------------------------------
// parseFiche
// ---------------------------------------------------------------------------

describe('parseFiche', () => {
  test('birthday « Né(e) le 2019-03-14 » → date_naissance "2019-03-14"', () => {
    assert.equal(parseFiche(FICHE).date_naissance, '2019-03-14');
  });

  test('coordonnées (nombres) et adresse lisible depuis content.establishment.map[0]', () => {
    const f = parseFiche(FICHE);
    assert.deepEqual(f.lieu, {
      latitude: 43.856085,
      longitude: -0.544466,
      adresse: '3288 Route de Haut Mauco, 40280 Saint-Pierre-Du-Mont',
    });
  });

  test('sexe « Mâle » → male, races jointes, description absente → null', () => {
    const f = parseFiche(FICHE);
    assert.equal(f.sexe, 'male');
    assert.equal(f.race, 'American Bully');
    assert.equal(f.description, null);
    const html = ficheAvec(null);
    html.content.infos.description = '<p>Très <strong>câlin</strong></p>';
    html.content.infos.races = [{ name: 'Europeen' }, { name: 'Siamois' }];
    const g = parseFiche(html);
    assert.equal(g.description, 'Très câlin');
    assert.equal(g.race, 'Europeen, Siamois');
  });

  test('fiche sans date de naissance ni établissement → champs null', () => {
    const f = ficheAvec(null);
    delete f.content.establishment;
    const p = parseFiche(f);
    assert.equal(p.date_naissance, null);
    assert.deepEqual(p.lieu, { latitude: null, longitude: null, adresse: null });
    assert.equal(parseFiche(null).date_naissance, null);
  });

  test('map[0] avec latitude/longitude null → null, pas (0, 0)', () => {
    const f = clone(FICHE);
    f.content.establishment.map[0].latitude = null;
    f.content.establishment.map[0].longitude = null;
    const p = parseFiche(f);
    assert.equal(p.lieu.latitude, null);
    assert.equal(p.lieu.longitude, null);
  });
});

// ---------------------------------------------------------------------------
// applyFiche
// ---------------------------------------------------------------------------

describe('applyFiche', () => {
  test('calcule age_mois depuis la date de naissance avec now fixé', () => {
    const l = mapSearchResult(ELLA, ETABS, NOW);
    applyFiche(l, parseFiche(ficheAvec('Né(e) le 2026-07-01')), NOW);
    assert.equal(l.date_naissance, '2026-07-01');
    presque(l.age_mois, mois(85.5), 'ELLA née le 01/07, now 24/09 12:00 UTC :');
    assert.equal(l.fiche_lue, true);
    // Même fiche, 30 jours plus tard : l'âge suit « now ».
    const plusTard = mapSearchResult(ELLA, ETABS, NOW);
    applyFiche(plusTard, { date_naissance: '2026-07-01' }, new Date('2026-10-24T12:00:00Z'));
    presque(plusTard.age_mois, mois(115.5));
  });

  test('la date de naissance prime sur l’âge textuel ; sans elle, l’âge textuel est conservé', () => {
    const avec = mapSearchResult(VICKY, ETABS, NOW);
    applyFiche(avec, { date_naissance: '2026-01-24' }, new Date('2026-09-24T00:00:00Z'));
    presque(avec.age_mois, mois(243));
    const sans = mapSearchResult(VICKY, ETABS, NOW);
    applyFiche(sans, { date_naissance: null }, NOW);
    assert.equal(sans.age_mois, 12);
    assert.equal(sans.fiche_lue, true);
    const ella = mapSearchResult(ELLA, ETABS, NOW);
    applyFiche(ella, { date_naissance: null }, NOW);
    assert.equal(ella.age_mois, null);
  });

  test('complète les coordonnées manquantes sans écraser celles de l’établissement', () => {
    const fiche = { date_naissance: null, lieu: { latitude: 45.1, longitude: 5.2, adresse: null } };
    const ella = applyFiche(mapSearchResult(ELLA, ETABS, NOW), fiche, NOW);
    assert.equal(ella.lieu.latitude, 45.1);
    assert.equal(ella.lieu.longitude, 5.2);
    assert.equal(ella.lieu.precision, 'exacte');
    const marley = applyFiche(mapSearchResult(MARLEY, ETABS, NOW), fiche, NOW);
    assert.equal(marley.lieu.latitude, 43.856085);
    assert.equal(marley.lieu.longitude, -0.544466);
  });

  test('ne remplace pas description / sexe / race déjà connus, complète ceux qui manquent', () => {
    const fiche = { date_naissance: null, description: 'Texte fiche', sexe: 'male', race: 'Siamois' };
    const brume = applyFiche(mapSearchResult(BRUME, ETABS, NOW), fiche, NOW);
    assert.match(brume.description, /Brume/);
    assert.equal(brume.sexe, 'femelle');
    assert.equal(brume.race, 'Europeen');
    const vide = mapSearchResult({ ...PERLE, sex: undefined, sex_label: undefined, races_label: '' }, ETABS, NOW);
    applyFiche(vide, fiche, NOW);
    assert.equal(vide.description, 'Texte fiche');
    assert.equal(vide.sexe, 'male');
    assert.equal(vide.race, 'Siamois');
  });

  test('fiche null → annonce renvoyée inchangée', () => {
    const l = mapSearchResult(ELLA, ETABS, NOW);
    const avant = clone(l);
    assert.equal(applyFiche(l, null, NOW), l);
    assert.deepEqual(l, avant);
  });
});

// ---------------------------------------------------------------------------
// fetchLaSpa (de bout en bout, faux http)
// ---------------------------------------------------------------------------

describe('fetchLaSpa', () => {
  test('charge les établissements puis les 2 pages de recherche (seed et taille de page fixes)', async () => {
    const http = fauxHttp();
    const { stats } = await fetchLaSpa({ http, config: CONFIG, state: emptyState(), zone: fausseZone(), now: NOW });
    assert.equal(http.appels[0], `${LASPA_BASE}/establishments/?api=1`);
    const r = http.recherches;
    assert.equal(r.length, 2);
    assert.deepEqual(r.map((u) => u.searchParams.get('paged')), ['1', '2']);
    for (const u of r) {
      assert.equal(`${u.origin}${u.pathname}`, `${LASPA_BASE}/animals/search/`);
      assert.equal(u.searchParams.get('api'), '1');
      assert.equal(u.searchParams.get('species'), 'chat');
      assert.equal(u.searchParams.get('posts_per_page'), '500');
    }
    assert.ok(r[0].searchParams.get('seed'));
    assert.equal(r[0].searchParams.get('seed'), r[1].searchParams.get('seed'), 'seed identique entre les pages');
    assert.equal(stats.pages, 2);
    assert.equal(stats.total_site, 6);
  });

  test('dédoublonne les IDs présents sur plusieurs pages', async () => {
    const zone = fausseZone();
    const { listings, stats } = await fetchLaSpa({ http: fauxHttp(), config: CONFIG, state: emptyState(), zone, now: NOW });
    assert.equal(listings.length, 6);
    assert.equal(new Set(listings.map((l) => l.id)).size, 6);
    assert.equal(listings.filter((l) => l.id === 'laspa:244109').length, 1);
    assert.equal(zone.soumises.length, 6, 'inZone appelé une fois par animal');
    assert.equal(stats.dans_zone, 6);
  });

  test('ne lit la fiche que des « junior » à l’âge N/A (une seule fois malgré le doublon)', async () => {
    const http = fauxHttp();
    const { stats } = await fetchLaSpa({ http, config: CONFIG, state: emptyState(), zone: fausseZone(), now: NOW });
    assert.deepEqual(http.fiches.sort(), ['animal-brume-7', 'animal-ella', 'animal-perle-9']);
    assert.ok(http.appels.includes(`${LASPA_BASE}/posts/?api=1&_uid=animal-ella`));
    assert.equal(stats.fiches, 3);
    assert.equal(stats.fiches_cache, 0);
    assert.equal(stats.erreurs, 0);
  });

  test('âge des chatons calculé depuis la fiche, âges textuels conservés, réservé détecté', async () => {
    const { listings } = await fetchLaSpa({ http: fauxHttp(), config: CONFIG, state: emptyState(), zone: fausseZone(), now: NOW });
    const l = parId(listings);
    presque(l['laspa:244109'].age_mois, mois(85.5), 'ELLA');
    presque(l['laspa:235940'].age_mois, mois(137.5), 'Brume');
    presque(l['laspa:235983'].age_mois, mois(40.5), 'PERLE');
    assert.equal(l['laspa:244109'].date_naissance, '2026-07-01');
    assert.equal(l['laspa:244109'].fiche_lue, true);
    assert.equal(l['laspa:235983'].reserve, true);
    assert.equal(l['laspa:240375'].age_mois, 12);
    assert.equal(l['laspa:240375'].fiche_lue, false);
    for (const x of listings) assert.equal('_now' in x, false, `_now retiré de ${x.id}`);
  });

  test('met les fiches en cache puis, au 2e appel, n’envoie aucune requête de fiche', async () => {
    const state = emptyState();
    await fetchLaSpa({ http: fauxHttp(), config: CONFIG, state, zone: fausseZone(), now: NOW });
    assert.deepEqual(Object.keys(state.fiches).sort(), ['laspa:235940', 'laspa:235983', 'laspa:244109']);
    assert.equal(state.fiches['laspa:244109'].date_naissance, '2026-07-01');
    assert.equal(state.fiches['laspa:244109'].mise_en_cache, NOW.toISOString());

    const http2 = fauxHttp({ fiches: {} }); // toute requête de fiche lèverait une erreur
    const { listings, stats } = await fetchLaSpa({ http: http2, config: CONFIG, state, zone: fausseZone(), now: NOW });
    assert.equal(http2.fiches.length, 0);
    assert.equal(stats.fiches, 0);
    assert.equal(stats.fiches_cache, 3);
    assert.equal(stats.erreurs, 0);
    const l = parId(listings);
    presque(l['laspa:244109'].age_mois, mois(85.5));
    assert.equal(l['laspa:244109'].fiche_lue, true);
  });

  test('cache préexistant : pas de requête pour cet animal, âge recalculé avec le now courant', async () => {
    const state = emptyState();
    state.fiches['laspa:244109'] = {
      date_naissance: '2026-07-01', description: null, sexe: 'femelle', race: null,
      lieu: { latitude: null, longitude: null, adresse: null }, mise_en_cache: '2026-09-01T08:00:00.000Z',
    };
    const http = fauxHttp();
    const now = new Date('2026-10-24T12:00:00Z');
    const { listings, stats } = await fetchLaSpa({ http, config: CONFIG, state, zone: fausseZone(), now });
    assert.deepEqual(http.fiches.sort(), ['animal-brume-7', 'animal-perle-9']);
    assert.equal(stats.fiches_cache, 1);
    assert.equal(stats.fiches, 2);
    presque(parId(listings)['laspa:244109'].age_mois, mois(115.5));
    assert.equal(state.fiches['laspa:244109'].mise_en_cache, '2026-09-01T08:00:00.000Z', 'entrée de cache non réécrite');
  });

  test('applique zone.inZone : les annonces hors zone sont exclues et leur fiche n’est pas lue', async () => {
    const http = fauxHttp();
    const zone = fausseZone({ accepte: (l) => l.id === 'laspa:244109' || l.id === 'laspa:242870' });
    const { listings, stats } = await fetchLaSpa({ http, config: CONFIG, state: emptyState(), zone, now: NOW });
    assert.deepEqual(listings.map((l) => l.id).sort(), ['laspa:242870', 'laspa:244109']);
    assert.equal(stats.dans_zone, 2);
    assert.deepEqual(http.fiches, ['animal-ella']);
  });

  test('calcule distance_km (coordonnées du refuge) avant d’appeler inZone', async () => {
    const zone = fausseZone({ mode: 'rayon', rayon_km: 500, centre: PARIS });
    const { listings } = await fetchLaSpa({ http: fauxHttp(), config: CONFIG, state: emptyState(), zone, now: NOW });
    const soumise = zone.soumises.find((s) => s.id === 'laspa:242870');
    const attendu = haversineKm(PARIS, MONT_DE_MARSAN);
    assert.ok(attendu > 550 && attendu < 650);
    presque(soumise.distance_km, attendu, 'distance Paris → Mont-de-Marsan');
    presque(parId(listings)['laspa:242870'].lieu.distance_km, attendu);
    assert.equal(zone.soumises.find((s) => s.id === 'laspa:244109').distance_km, null, 'refuge sans coordonnées');
  });

  test('ne demande que les « junior » (moins d’un an) par défaut : paramètre age=junior sur chaque page', async () => {
    const http = fauxHttp();
    await fetchLaSpa({ http, config: CONFIG, state: emptyState(), zone: fausseZone(), now: NOW });
    assert.ok(http.recherches.length > 0);
    for (const u of http.recherches) assert.equal(u.searchParams.get('age'), 'junior');
  });

  test('sources.laspa.categories_age : catégories transmises à l’API séparées par des virgules', async () => {
    const http = fauxHttp();
    const config = { ...CONFIG, sources: { ...CONFIG.sources, laspa: { actif: true, categories_age: ['junior', 'adult', 'senior'] } } };
    await fetchLaSpa({ http, config, state: emptyState(), zone: fausseZone(), now: NOW });
    for (const u of http.recherches) assert.equal(u.searchParams.get('age'), 'junior,adult,senior');
  });

  test('latitude/longitude transmises à l’API quand le rayon est ≤ 90 km', async () => {
    for (const rayon_km of [30, 90]) {
      const http = fauxHttp();
      const zone = fausseZone({ mode: 'rayon', rayon_km, centre: PARIS });
      await fetchLaSpa({ http, config: CONFIG, state: emptyState(), zone, now: NOW });
      for (const u of http.recherches) {
        assert.equal(u.searchParams.get('latitude'), '48.857', `rayon ${rayon_km}`);
        assert.equal(u.searchParams.get('longitude'), '2.352', `rayon ${rayon_km}`);
      }
    }
  });

  test('pas de latitude/longitude au-delà de 90 km, en mode départements / France ou sans centre', async () => {
    const zones = [
      fausseZone({ mode: 'rayon', rayon_km: 91, centre: PARIS }),
      fausseZone({ mode: 'rayon', rayon_km: 200, centre: PARIS }),
      fausseZone({ mode: 'departements', rayon_km: 0, centre: PARIS }),
      fausseZone({ mode: 'france', rayon_km: 0, centre: null }),
      fausseZone({ mode: 'rayon', rayon_km: 30, centre: null }),
    ];
    for (const zone of zones) {
      const http = fauxHttp();
      await fetchLaSpa({ http, config: CONFIG, state: emptyState(), zone, now: NOW });
      for (const u of http.recherches) {
        assert.equal(u.searchParams.has('latitude'), false, `${zone.mode} ${zone.rayon_km} km`);
        assert.equal(u.searchParams.has('longitude'), false, `${zone.mode} ${zone.rayon_km} km`);
      }
    }
  });

  test('une fiche en erreur est comptée dans stats.erreurs sans faire échouer la source', async () => {
    const fiches = fichesJunior();
    fiches['animal-perle-9'] = new Error('HTTP 500');
    const journal = [];
    const state = emptyState();
    const { listings, stats } = await fetchLaSpa({
      http: fauxHttp({ fiches }), config: CONFIG, state, zone: fausseZone(), now: NOW, log: (m) => journal.push(m),
    });
    assert.equal(stats.erreurs, 1);
    assert.equal(stats.fiches, 2);
    assert.equal(listings.length, 6);
    const perle = parId(listings)['laspa:235983'];
    assert.equal(perle.age_mois, null);
    assert.equal(perle.fiche_lue, false);
    assert.equal('laspa:235983' in state.fiches, false, 'une fiche en échec n’est pas mise en cache');
    presque(parId(listings)['laspa:244109'].age_mois, mois(85.5), 'les autres fiches sont appliquées');
    assert.ok(journal.some((m) => m.includes('animal-perle-9') && m.includes('HTTP 500')));
  });

  test('fiche sans date de naissance : mise en cache, âge inconnu, pas de nouvelle requête ensuite', async () => {
    const fiches = fichesJunior();
    fiches['animal-brume-7'] = ficheAvec(null);
    const state = emptyState();
    const { listings } = await fetchLaSpa({ http: fauxHttp({ fiches }), config: CONFIG, state, zone: fausseZone(), now: NOW });
    const brume = parId(listings)['laspa:235940'];
    assert.equal(brume.age_mois, null);
    assert.equal(brume.fiche_lue, true);
    assert.equal(state.fiches['laspa:235940'].date_naissance, null);
    const http2 = fauxHttp({ fiches: {} });
    await fetchLaSpa({ http: http2, config: CONFIG, state, zone: fausseZone(), now: NOW });
    assert.equal(http2.fiches.length, 0);
  });

  test('une page sans résultat et sans nb_pages : une seule requête de recherche', async () => {
    const http = fauxHttp({ pages: [{ total: 0, results: [] }] });
    const { listings, stats } = await fetchLaSpa({ http, config: CONFIG, state: emptyState(), zone: fausseZone(), now: NOW });
    assert.equal(http.recherches.length, 1);
    assert.equal(listings.length, 0);
    assert.equal(stats.total_site, 0);
    assert.equal(stats.pages, 1);
  });

  test('pagination plafonnée à 50 pages même si nb_pages est plus grand', async () => {
    const http = fauxHttp({ pages: () => ({ total: 0, nb_pages: 80, results: [] }) });
    const { stats } = await fetchLaSpa({ http, config: CONFIG, state: emptyState(), zone: fausseZone(), now: NOW });
    assert.equal(http.recherches.length, 50);
    assert.equal(stats.pages, 50);
  });

  test('une erreur sur la liste des établissements fait échouer la source (rejet)', async () => {
    const http = fauxHttp();
    http.getJson = async () => { throw new Error('HTTP 503'); };
    await assert.rejects(
      fetchLaSpa({ http, config: CONFIG, state: emptyState(), zone: fausseZone(), now: NOW }),
      /HTTP 503/,
    );
  });

  test('intégration avec buildZone : rayon 30 km autour de Mont-de-Marsan → seul Marley est retenu', async () => {
    const config = { zone: { mode: 'rayon', rayon_km: 30, centre: { latitude: 43.89, longitude: -0.5 } } };
    const zone = await buildZone(config);
    const http = fauxHttp();
    const { listings, stats } = await fetchLaSpa({ http, config, state: emptyState(), zone, now: NOW });
    assert.deepEqual(listings.map((l) => l.id), ['laspa:242870']);
    assert.ok(listings[0].lieu.distance_km < 10);
    assert.equal(stats.dans_zone, 1);
    assert.equal(http.fiches.length, 0, 'Marley a un âge connu (1 an) : pas de fiche');
    assert.equal(http.recherches[0].searchParams.get('latitude'), '43.89');
  });
});
