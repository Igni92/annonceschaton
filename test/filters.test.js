// Tests de src/filters.js (zone géographique, sélection des chatons / nouveaux arrivants, dédoublonnage)
// et de src/state.js (mémoire du bot entre deux exécutions).
// Aucun accès réseau : le centre de zone est donné en coordonnées (pas de géocodage) ;
// « maintenant » est figé ; les fichiers d'état sont écrits dans un dossier temporaire (os.tmpdir()).

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildZone, dedupe, selectKittens, selectNewcomers } from '../src/filters.js';
import { haversineKm } from '../src/geo.js';
import {
  emptyState,
  firstSeen,
  getCachedFiche,
  loadState,
  markSeen,
  pruneState,
  saveState,
  setCachedFiche,
} from '../src/state.js';

const JOUR_MS = 86_400_000;

/** « Maintenant » figé : 24/09/2026 à 08:00, heure de Paris (06:00 UTC). */
const MAINTENANT = new Date('2026-09-24T06:00:00.000Z');

/** Centre de zone donné en coordonnées (Paris, Hôtel de Ville) : aucune résolution réseau. */
const PARIS = { latitude: 48.857, longitude: 2.352 };

// Quelques lieux réels autour de Paris (distances au centre calculées par haversineKm).
const GENNEVILLIERS = { latitude: 48.94, longitude: 2.30 }; // refuge SPA, ≈ 10 km, dép. 92
const FONTAINEBLEAU = { latitude: 48.405, longitude: 2.70 }; // ≈ 56 km, dép. 77
const BEAUVAIS = { latitude: 49.43, longitude: 2.081 }; // chef-lieu de l'Oise, ≈ 67 km, dép. 60
const LYON = { latitude: 45.764, longitude: 4.836 }; // ≈ 392 km, dép. 69

/** Configuration minimale pour buildZone. */
function configZone(zone) {
  return { zone };
}

/** Zone « rayon » centrée sur Paris (coordonnées), marge explicite pour ne pas dépendre du défaut. */
function zoneRayon({ rayon_km = 50, marge_departement_km = 25, centre = { ...PARIS, ville: 'Paris' } } = {}) {
  return buildZone(configZone({ mode: 'rayon', centre, rayon_km, marge_departement_km }));
}

/** Configuration minimale pour selectKittens / selectNewcomers. */
function configSelection({ age_max_mois = 4, inclure_reserves = false, ...na } = {}) {
  return {
    age_max_mois,
    inclure_reserves,
    nouveaux_arrivants: { jours: 7, critere: 'les_deux', tous_ages: true, ...na },
  };
}

/** Annonce normalisée minimale (même forme que celles produites par src/sources/). */
function annonce(id, { age_mois = null, reserve = false, date_publication = null, distance_km = null, source = 'laspa', nom } = {}) {
  return { id, source, nom: nom ?? `Chat ${id}`, age_mois, reserve, date_publication, lieu: { distance_km } };
}

const ids = (listings) => listings.map((l) => l.id);

// ---------------------------------------------------------------------------
// buildZone — mode « rayon »
// ---------------------------------------------------------------------------

describe('buildZone — mode rayon (centre en coordonnées)', () => {
  test('construit la zone sans réseau : centre, rayon, marge, libellé', async () => {
    const logs = [];
    const zone = await buildZone(
      configZone({ mode: 'rayon', centre: { ...PARIS, ville: 'Paris' }, rayon_km: 50, marge_departement_km: 25 }),
      null,
      (m) => logs.push(m),
    );
    assert.equal(zone.mode, 'rayon');
    assert.equal(zone.rayon_km, 50);
    assert.equal(zone.marge_departement_km, 25);
    assert.equal(zone.centre.methode, 'coordonnees');
    assert.equal(zone.centre.latitude, PARIS.latitude);
    assert.equal(zone.centre.longitude, PARIS.longitude);
    assert.equal(zone.label, '50 km autour de Paris');
    assert.deepEqual(zone.departements, []);
    assert.ok(logs.some((m) => m.includes('50 km autour de Paris')), 'la zone est journalisée');
  });

  test('départements acceptés = chefs-lieux à moins de rayon + marge du centre', async () => {
    assert.deepEqual(
      (await zoneRayon({ rayon_km: 50, marge_departement_km: 25 })).departements_acceptes,
      ['60', '75', '77', '78', '91', '92', '93', '94', '95'],
    );
    // Une marge de 0 est respectée (pas remplacée par la valeur par défaut).
    const serree = await zoneRayon({ rayon_km: 20, marge_departement_km: 0 });
    assert.equal(serree.marge_departement_km, 0);
    assert.deepEqual(serree.departements_acceptes, ['75', '78', '92', '93', '94']);
  });

  test('annonce avec coordonnées : acceptée dans le rayon, refusée au-delà', async () => {
    const zone = await zoneRayon({ rayon_km: 50 });
    const exacte = (pt, departement) => ({ lieu: { ...pt, departement, precision: 'exacte', distance_km: null } });
    assert.equal(zone.inZone(exacte(GENNEVILLIERS, '92')), true); // ≈ 10 km
    assert.equal(zone.inZone(exacte(LYON, '69')), false); // ≈ 392 km
  });

  test('coordonnées exactes : la distance prime sur le département (même accepté)', async () => {
    const zone = await zoneRayon({ rayon_km: 50, marge_departement_km: 25 });
    assert.ok(zone.departements_acceptes.includes('77'));
    // Fontainebleau (77) est à ≈ 56 km : hors rayon malgré un département « à portée ».
    assert.equal(zone.inZone({ lieu: { ...FONTAINEBLEAU, departement: '77', precision: 'exacte' } }), false);
  });

  test('limite du rayon incluse (distance ≤ rayon_km), exclue juste au-delà', async () => {
    const d = haversineKm(PARIS, FONTAINEBLEAU);
    const lieu = { ...FONTAINEBLEAU, departement: '77', precision: 'exacte', distance_km: null };
    assert.equal((await zoneRayon({ rayon_km: d })).inZone({ lieu }), true);
    assert.equal((await zoneRayon({ rayon_km: d - 0.001 })).inZone({ lieu }), false);
  });

  test('distance_km déjà calculée par la source est utilisée ; sinon calculée depuis les coordonnées', async () => {
    const zone = await zoneRayon({ rayon_km: 20 });
    // distance_km fournie : c'est elle qui fait foi.
    assert.equal(zone.inZone({ lieu: { ...GENNEVILLIERS, departement: '92', precision: 'exacte', distance_km: 25 } }), false);
    assert.equal(zone.inZone({ lieu: { ...GENNEVILLIERS, departement: '92', precision: 'exacte', distance_km: 19.9 } }), true);
    // distance_km absente : recalculée (≈ 10 km).
    assert.equal(zone.inZone({ lieu: { ...GENNEVILLIERS, departement: '92', precision: 'exacte' } }), true);
  });

  test('précision « departement » : tolérance par département, coordonnées ignorées', async () => {
    const zone = await zoneRayon({ rayon_km: 50, marge_departement_km: 25 });
    // Coordonnées du chef-lieu de l'Oise (≈ 67 km, hors rayon) mais département 60 à portée → accepté.
    assert.equal(zone.inZone({ lieu: { ...BEAUVAIS, departement: '60', precision: 'departement' } }), true);
    // Coordonnées parisiennes mais département lointain → refusé.
    assert.equal(zone.inZone({ lieu: { ...PARIS, departement: '69', precision: 'departement' } }), false);
  });

  test('annonce sans coordonnées (Seconde Chance, SPA sans GPS) : tolérance par département', async () => {
    const zone = await zoneRayon({ rayon_km: 50, marge_departement_km: 25 });
    const sansCoord = (departement, extra = {}) => ({
      lieu: { latitude: null, longitude: null, precision: 'departement', departement, distance_km: null, ...extra },
    });
    assert.equal(zone.inZone(sansCoord('92')), true);
    assert.equal(zone.inZone(sansCoord('69')), false);
    assert.equal(zone.inZone(sansCoord('93', { precision: 'inconnue' })), true);
    // Département de l'annonce hors zone mais adoptable dans un département à portée.
    assert.equal(zone.inZone(sansCoord('28', { departements_adoption: ['28', '92'] })), true);
    // departements_adoption est un Set pendant la collecte Seconde Chance.
    assert.equal(zone.inZone(sansCoord(null, { departements_adoption: new Set(['94']) })), true);
  });

  test('annonce sans lieu ni département : refusée', async () => {
    const zone = await zoneRayon();
    assert.equal(zone.inZone({}), false);
    assert.equal(zone.inZone({ lieu: {} }), false);
    assert.equal(zone.inZone(undefined), false);
  });

  test(
    'marge_departement_km absente : défaut documenté de 25 km (README)',
    async () => {
      const zone = await buildZone(configZone({ mode: 'rayon', centre: { ...PARIS, ville: 'Paris' }, rayon_km: 50 }));
      assert.equal(zone.marge_departement_km, 25);
      // Avec 25 km : l'Eure (27) et l'Eure-et-Loir (28) ne sont pas « à portée » d'un rayon de 50 km autour de Paris.
      assert.deepEqual(zone.departements_acceptes, ['60', '75', '77', '78', '91', '92', '93', '94', '95']);
    },
  );
});

// ---------------------------------------------------------------------------
// buildZone — mode « departements » et « france »
// ---------------------------------------------------------------------------

describe('buildZone — mode departements', () => {
  test('codes normalisés, libellé, centre indicatif = préfecture du premier département', async () => {
    const zone = await buildZone(configZone({ mode: 'departements', departements: ['75', '9', '2a'] }));
    assert.equal(zone.mode, 'departements');
    assert.deepEqual(zone.departements, ['75', '09', '2A']);
    assert.deepEqual(zone.departements_acceptes, ['09', '2A', '75']);
    assert.equal(zone.label, 'départements 75, 09, 2A');
    assert.equal(zone.centre.departement, '75');
    assert.equal(zone.centre.latitude, 48.857);
  });

  test('appartenance via lieu.departement', async () => {
    const zone = await buildZone(configZone({ mode: 'departements', departements: ['75', '92'] }));
    assert.equal(zone.inZone({ lieu: { departement: '92' } }), true);
    assert.equal(zone.inZone({ lieu: { departement: '93' } }), false);
  });

  test('appartenance via lieu.departements_adoption (tableau ou Set)', async () => {
    const zone = await buildZone(configZone({ mode: 'departements', departements: ['75', '92'] }));
    assert.equal(zone.inZone({ lieu: { departement: '60', departements_adoption: ['60', '92'] } }), true);
    assert.equal(zone.inZone({ lieu: { departement: null, departements_adoption: new Set(['75']) } }), true);
    assert.equal(zone.inZone({ lieu: { departement: '60', departements_adoption: ['60', '95'] } }), false);
  });

  test('les coordonnées ne suffisent pas : seul le département compte', async () => {
    const zone = await buildZone(configZone({ mode: 'departements', departements: ['75'] }));
    assert.equal(zone.inZone({ lieu: { ...PARIS, precision: 'exacte', departement: null } }), false);
    assert.equal(zone.inZone({ lieu: { ...PARIS, precision: 'exacte', departement: '69' } }), false);
    assert.equal(zone.inZone({ lieu: { ...LYON, precision: 'exacte', departement: '75' } }), true);
  });
});

describe('buildZone — mode france', () => {
  test('aucun filtre : tout est dans la zone, pas de centre', async () => {
    const zone = await buildZone(configZone({ mode: 'france' }));
    assert.equal(zone.mode, 'france');
    assert.equal(zone.centre, null);
    assert.equal(zone.label, 'France entière');
    assert.deepEqual(zone.departements_acceptes, []);
    assert.equal(zone.inZone({ lieu: { ...LYON, departement: '69', precision: 'exacte' } }), true);
    assert.equal(zone.inZone({ lieu: { departement: '974' } }), true);
    assert.equal(zone.inZone({}), true);
    assert.equal(zone.inZone(undefined), true);
  });
});

// ---------------------------------------------------------------------------
// selectKittens
// ---------------------------------------------------------------------------

describe('selectKittens', () => {
  test('âge connu et strictement inférieur à age_max_mois', () => {
    const listings = [
      annonce('a', { age_mois: 0.5 }),
      annonce('b', { age_mois: 3.99 }),
      annonce('c', { age_mois: 4 }), // pile la limite : exclu
      annonce('d', { age_mois: 4.5 }),
      annonce('e', { age_mois: null }), // âge inconnu : exclu
      annonce('f', { age_mois: 36 }),
    ];
    assert.deepEqual(ids(selectKittens(listings, configSelection({ age_max_mois: 4 }))).sort(), ['a', 'b']);
    assert.deepEqual(ids(selectKittens(listings, configSelection({ age_max_mois: 6 }))).sort(), ['a', 'b', 'c', 'd']);
  });

  test('réservés exclus par défaut, inclus avec inclure_reserves', () => {
    const listings = [annonce('libre', { age_mois: 2 }), annonce('reserve', { age_mois: 2, reserve: true })];
    assert.deepEqual(ids(selectKittens(listings, configSelection())), ['libre']);
    assert.deepEqual(ids(selectKittens(listings, configSelection({ inclure_reserves: true }))).sort(), ['libre', 'reserve']);
  });

  test('tri par distance croissante (distance inconnue en dernier), puis par âge', () => {
    const listings = [
      annonce('loin', { age_mois: 2, distance_km: 12 }),
      annonce('sc-vieux', { age_mois: 1, distance_km: null }),
      annonce('pres-vieux', { age_mois: 3, distance_km: 5 }),
      annonce('pres-jeune', { age_mois: 1, distance_km: 5 }),
      annonce('sc-jeune', { age_mois: 0.5, distance_km: null }),
    ];
    const copie = [...listings];
    assert.deepEqual(ids(selectKittens(listings, configSelection())), ['pres-jeune', 'pres-vieux', 'loin', 'sc-jeune', 'sc-vieux']);
    assert.deepEqual(listings, copie, "le tableau d'entrée n'est pas modifié");
  });
});

// ---------------------------------------------------------------------------
// selectNewcomers
// ---------------------------------------------------------------------------

describe('selectNewcomers', () => {
  test('critère date_publication : mis en ligne dans les N derniers jours', () => {
    const listings = [
      annonce('aujourdhui', { date_publication: '2026-09-24' }),
      annonce('j-6', { date_publication: '2026-09-18' }),
      annonce('j-8', { date_publication: '2026-09-16' }),
      annonce('sans-date', { date_publication: null }),
      annonce('date-invalide', { date_publication: 'hier' }),
    ];
    const fresh = new Set(ids(listings)); // tous jamais vus : ignoré par ce critère
    const res = selectNewcomers(listings, configSelection({ critere: 'date_publication', jours: 7 }), { fresh, now: MAINTENANT });
    assert.deepEqual(ids(res), ['aujourdhui', 'j-6']);
  });

  test('critère premiere_vue : identifiants jamais vus (fresh ou absents de l\'état)', () => {
    const state = emptyState();
    state.vus.connu = { premiere_vue: '2026-09-01T06:00:00.000Z', derniere_vue: '2026-09-23T06:00:00.000Z' };
    state.vus['connu-recent'] = { premiere_vue: '2026-09-23T06:00:00.000Z', derniere_vue: '2026-09-23T06:00:00.000Z' };
    const listings = [
      annonce('connu', { date_publication: '2026-09-24' }), // récent mais déjà vu : exclu
      annonce('connu-recent'),
      annonce('dans-fresh'),
      annonce('absent-etat'),
    ];
    state.vus['dans-fresh'] = { premiere_vue: MAINTENANT.toISOString(), derniere_vue: MAINTENANT.toISOString() };
    const res = selectNewcomers(listings, configSelection({ critere: 'premiere_vue' }), {
      state, fresh: new Set(['dans-fresh']), now: MAINTENANT,
    });
    assert.deepEqual(ids(res).sort(), ['absent-etat', 'dans-fresh']);
  });

  test('critère premiere_vue sans état ni fresh : aucun nouvel arrivant', () => {
    const res = selectNewcomers([annonce('x'), annonce('y')], configSelection({ critere: 'premiere_vue' }), { now: MAINTENANT });
    assert.deepEqual(res, []);
  });

  test('critère les_deux : date récente OU jamais vu', () => {
    const state = emptyState();
    for (const id of ['recent-connu', 'ancien-connu']) {
      state.vus[id] = { premiere_vue: '2026-08-01T06:00:00.000Z', derniere_vue: '2026-09-23T06:00:00.000Z' };
    }
    const listings = [
      annonce('recent-connu', { date_publication: '2026-09-22' }),
      annonce('ancien-connu', { date_publication: '2026-07-01' }),
      annonce('ancien-nouveau', { date_publication: '2026-07-01' }),
    ];
    const res = selectNewcomers(listings, configSelection({ critere: 'les_deux' }), {
      state, fresh: new Set(['ancien-nouveau']), now: MAINTENANT,
    });
    assert.deepEqual(ids(res).sort(), ['ancien-nouveau', 'recent-connu']);
  });

  test('enchaînement markSeen → selectNewcomers (comme src/run.js)', () => {
    const state = emptyState();
    markSeen(state, [annonce('hier')], new Date(MAINTENANT.getTime() - JOUR_MS));
    const listings = [annonce('hier'), annonce('nouveau')];
    const fresh = markSeen(state, listings, MAINTENANT);
    const res = selectNewcomers(listings, configSelection({ critere: 'premiere_vue' }), { state, fresh, now: MAINTENANT });
    assert.deepEqual(ids(res), ['nouveau']);
  });

  test('tous_ages false : seulement les chatons (âge connu < age_max_mois)', () => {
    const listings = [
      annonce('chaton', { age_mois: 2, date_publication: '2026-09-23' }),
      annonce('limite', { age_mois: 4, date_publication: '2026-09-23' }),
      annonce('adulte', { age_mois: 36, date_publication: '2026-09-23' }),
      annonce('inconnu', { age_mois: null, date_publication: '2026-09-23' }),
    ];
    const cfg = configSelection({ critere: 'date_publication', tous_ages: false });
    assert.deepEqual(ids(selectNewcomers(listings, cfg, { now: MAINTENANT })), ['chaton']);
    const tous = configSelection({ critere: 'date_publication', tous_ages: true });
    assert.equal(selectNewcomers(listings, tous, { now: MAINTENANT }).length, 4);
  });

  test('réservés exclus sauf inclure_reserves', () => {
    const listings = [annonce('libre', { date_publication: '2026-09-23' }), annonce('pris', { date_publication: '2026-09-23', reserve: true })];
    assert.deepEqual(ids(selectNewcomers(listings, configSelection({ critere: 'date_publication' }), { now: MAINTENANT })), ['libre']);
    const avec = configSelection({ critere: 'date_publication', inclure_reserves: true });
    assert.deepEqual(ids(selectNewcomers(listings, avec, { now: MAINTENANT })).sort(), ['libre', 'pris']);
  });

  test('tri par date de publication décroissante, puis distance ; sans date en dernier', () => {
    const listings = [
      annonce('20-sept', { date_publication: '2026-09-20', distance_km: 30 }),
      annonce('sans-date', { date_publication: null, distance_km: 1 }),
      annonce('23-sept-loin', { date_publication: '2026-09-23', distance_km: 50 }),
      annonce('23-sept-pres', { date_publication: '2026-09-23', distance_km: 10 }),
      annonce('24-sept', { date_publication: '2026-09-24', distance_km: null }),
    ];
    const res = selectNewcomers(listings, configSelection({ critere: 'les_deux' }), { fresh: new Set(['sans-date']), now: MAINTENANT });
    assert.deepEqual(ids(res), ['24-sept', '23-sept-pres', '23-sept-loin', '20-sept', 'sans-date']);
  });

  test(
    'jours = 1 : une annonce mise en ligne la veille (après l\'heure du passage quotidien) est signalée',
    () => {
      // Passage du 23/09 à 08:00 (Paris) : l'annonce publiée le 23/09 à 20:00 n'existait pas encore.
      // Passage du 24/09 à 08:00 : elle a 12 h, elle doit apparaître comme « mise en ligne depuis moins d'1 jour ».
      const listings = [annonce('publiee-hier-soir', { date_publication: '2026-09-23' })];
      const res = selectNewcomers(listings, configSelection({ critere: 'date_publication', jours: 1 }), { now: MAINTENANT });
      assert.deepEqual(ids(res), ['publiee-hier-soir']);
    },
  );
});

// ---------------------------------------------------------------------------
// dedupe
// ---------------------------------------------------------------------------

describe('dedupe', () => {
  test('supprime les doublons d\'identifiant en conservant la première occurrence et l\'ordre', () => {
    const premier = annonce('laspa:1', { nom: 'Premier' });
    const listings = [premier, annonce('sc:2'), annonce('laspa:1', { nom: 'Doublon' }), annonce('sc:3'), annonce('sc:2')];
    const res = dedupe(listings);
    assert.deepEqual(ids(res), ['laspa:1', 'sc:2', 'sc:3']);
    assert.equal(res[0], premier);
    assert.equal(listings.length, 5, "le tableau d'entrée n'est pas modifié");
  });

  test('liste vide ou sans doublon : inchangée', () => {
    assert.deepEqual(dedupe([]), []);
    const l = [annonce('a'), annonce('b')];
    assert.deepEqual(dedupe(l), l);
  });
});

// ---------------------------------------------------------------------------
// src/state.js
// ---------------------------------------------------------------------------

describe('state — loadState / saveState', () => {
  let dossier;
  before(() => { dossier = mkdtempSync(path.join(os.tmpdir(), 'annonceschaton-state-')); });
  after(() => { rmSync(dossier, { recursive: true, force: true }); });

  test('fichier absent : état vide, sans message', () => {
    const logs = [];
    const state = loadState(path.join(dossier, 'inexistant.json'), (m) => logs.push(m));
    assert.deepEqual(state, emptyState());
    assert.deepEqual(state, { version: 1, derniere_execution: null, vus: {}, fiches: {} });
    assert.deepEqual(logs, []);
  });

  test('fichier corrompu : état vide et avertissement', () => {
    for (const contenu of ['{ pas du json', 'null', '42']) {
      const fichier = path.join(dossier, 'corrompu.json');
      writeFileSync(fichier, contenu);
      const logs = [];
      assert.deepEqual(loadState(fichier, (m) => logs.push(m)), emptyState(), `contenu ${contenu}`);
      assert.equal(logs.length, 1, `un avertissement pour ${contenu}`);
      assert.match(logs[0], /illisible/);
    }
  });

  test('fichier partiel : clés manquantes complétées, données conservées', () => {
    const fichier = path.join(dossier, 'partiel.json');
    writeFileSync(fichier, JSON.stringify({ derniere_execution: '2026-09-23T06:00:00.000Z', vus: { a: { premiere_vue: 'x' } }, fiches: null }));
    const state = loadState(fichier);
    assert.equal(state.version, 1);
    assert.equal(state.derniere_execution, '2026-09-23T06:00:00.000Z');
    assert.deepEqual(state.vus, { a: { premiere_vue: 'x' } });
    assert.deepEqual(state.fiches, {});
  });

  test('saveState : crée les dossiers, écrit un JSON relisible, ne laisse pas de fichier temporaire', () => {
    const fichier = path.join(dossier, 'sous', 'dossier', 'state.json');
    const state = emptyState();
    markSeen(state, [annonce('laspa:1')], MAINTENANT);
    setCachedFiche(state, 'laspa:1', { date_naissance: '2026-07-01' }, MAINTENANT);
    saveState(fichier, state);
    assert.deepEqual(loadState(fichier), state);
    assert.deepEqual(readdirSync(path.dirname(fichier)), ['state.json']);
  });

  test('saveState atomique : remplace l\'ancien fichier, et le laisse intact si la sérialisation échoue', () => {
    const fichier = path.join(dossier, 'atomique.json');
    saveState(fichier, { ...emptyState(), derniere_execution: 'v1' });
    saveState(fichier, { ...emptyState(), derniere_execution: 'v2' });
    assert.equal(loadState(fichier).derniere_execution, 'v2');
    const avant = readFileSync(fichier, 'utf8');
    // BigInt n'est pas sérialisable en JSON : l'écriture échoue avant de toucher au fichier existant.
    assert.throws(() => saveState(fichier, { ...emptyState(), derniere_execution: 1n }), TypeError);
    assert.equal(readFileSync(fichier, 'utf8'), avant);
    assert.equal(existsSync(`${fichier}.tmp`), false);
  });
});

describe('state — markSeen / firstSeen', () => {
  test('retourne les identifiants jamais vus et les enregistre', () => {
    const state = emptyState();
    const fresh = markSeen(state, [annonce('laspa:1', { nom: 'Perle' }), annonce('sc:2', { source: 'secondechance' })], MAINTENANT);
    assert.deepEqual([...fresh].sort(), ['laspa:1', 'sc:2']);
    assert.deepEqual(state.vus['laspa:1'], {
      premiere_vue: MAINTENANT.toISOString(), derniere_vue: MAINTENANT.toISOString(), source: 'laspa', nom: 'Perle',
    });
    assert.equal(firstSeen(state, 'laspa:1'), MAINTENANT.toISOString());
    assert.equal(firstSeen(state, 'inconnu'), null);
  });

  test('annonce déjà vue : pas dans le résultat, derniere_vue mise à jour, premiere_vue conservée', () => {
    const state = emptyState();
    const hier = new Date(MAINTENANT.getTime() - JOUR_MS);
    markSeen(state, [annonce('laspa:1')], hier);
    const fresh = markSeen(state, [annonce('laspa:1'), annonce('laspa:2'), annonce('laspa:2')], MAINTENANT);
    assert.deepEqual([...fresh], ['laspa:2']);
    assert.equal(state.vus['laspa:1'].premiere_vue, hier.toISOString());
    assert.equal(state.vus['laspa:1'].derniere_vue, MAINTENANT.toISOString());
    assert.equal(markSeen(state, [annonce('laspa:1'), annonce('laspa:2')], MAINTENANT).size, 0);
  });
});

describe('state — cache des fiches', () => {
  test('getCachedFiche : null si absent ; setCachedFiche horodate sans modifier les données fournies', () => {
    const state = emptyState();
    assert.equal(getCachedFiche(state, 'sc:1519459'), null);
    const fiche = { date_naissance: '2026-03-01', association: { nom: 'AFELP', code_postal: '95300' } };
    setCachedFiche(state, 'sc:1519459', fiche, MAINTENANT);
    assert.deepEqual(getCachedFiche(state, 'sc:1519459'), { ...fiche, mise_en_cache: MAINTENANT.toISOString() });
    assert.equal('mise_en_cache' in fiche, false);
    assert.equal(getCachedFiche({ vus: {} }, 'sc:1519459'), null, 'état sans cache');
  });
});

describe('state — pruneState', () => {
  const ilYa = (jours) => new Date(MAINTENANT.getTime() - jours * JOUR_MS).toISOString();

  test('purge les annonces non revues depuis plus de N jours (avec leur fiche), garde les récentes', () => {
    const state = emptyState();
    state.vus.ancien = { premiere_vue: ilYa(200), derniere_vue: ilYa(91) };
    state.vus.recent = { premiere_vue: ilYa(200), derniere_vue: ilYa(1) };
    state.vus.limite = { premiere_vue: ilYa(90), derniere_vue: ilYa(90) }; // exactement à la limite : gardé
    state.vus['sans-derniere'] = { premiere_vue: ilYa(10) }; // repli sur premiere_vue
    state.vus['sans-date'] = {}; // aucune date : purgé
    state.fiches.ancien = { mise_en_cache: ilYa(1) };
    state.fiches.recent = { mise_en_cache: ilYa(150) }; // cache ancien mais annonce revue : gardé
    const retires = pruneState(state, 90, MAINTENANT);
    assert.equal(retires, 2);
    assert.deepEqual(Object.keys(state.vus).sort(), ['limite', 'recent', 'sans-derniere']);
    assert.deepEqual(Object.keys(state.fiches), ['recent']);
  });

  test('fiches orphelines : purgées si anciennes, gardées si récentes', () => {
    const state = emptyState();
    state.fiches['orpheline-ancienne'] = { mise_en_cache: ilYa(120) };
    state.fiches['orpheline-recente'] = { mise_en_cache: ilYa(3) };
    state.fiches['orpheline-sans-date'] = {};
    assert.equal(pruneState(state, 90, MAINTENANT), 2);
    assert.deepEqual(Object.keys(state.fiches), ['orpheline-recente']);
  });

  test('rétention courte : 7 jours', () => {
    const state = emptyState();
    state.vus.a = { premiere_vue: ilYa(8), derniere_vue: ilYa(8) };
    state.vus.b = { premiere_vue: ilYa(8), derniere_vue: ilYa(6) };
    assert.equal(pruneState(state, 7, MAINTENANT), 1);
    assert.deepEqual(Object.keys(state.vus), ['b']);
  });
});
