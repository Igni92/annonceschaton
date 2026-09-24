// Tests de src/geo.js : distances, départements, géocodage et résolution du centre.
// Aucun accès réseau : le géocodage reçoit un faux client http ({ getJson, getText }).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEPARTEMENTS,
  haversineKm,
  normalizeDepartement,
  departementFromPostcode,
  postcodeFromAddress,
  departementCentre,
  departementsAutour,
  geocodeAdresse,
  resolveCentre,
} from '../src/geo.js';

const PARIS = { latitude: 48.857, longitude: 2.352 };
const LYON = { latitude: 45.764, longitude: 4.836 };

/** Faux client http : mémorise les URL demandées et renvoie `reponse` (ou lève `erreur`). */
function fauxHttp({ reponse = null, erreur = null } = {}) {
  const appels = [];
  return {
    appels,
    async getJson(url) {
      appels.push(url);
      if (erreur) throw erreur;
      return typeof reponse === 'function' ? reponse(url) : reponse;
    },
    async getText(url) {
      appels.push(url);
      throw new Error('getText ne devrait pas être appelé par le géocodage');
    },
  };
}

/** Réponse type d'api-adresse.data.gouv.fr (FeatureCollection GeoJSON). */
function reponseApiAdresse({ lon = 2.3795, lat = 48.8593, label = '75011 Paris', postcode = '75011', context = '75, Paris, Île-de-France' } = {}) {
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { label, postcode, context, city: 'Paris', type: 'municipality' },
    }],
  };
}

describe('haversineKm', () => {
  test('Paris → Lyon ≈ 392 km', () => {
    const d = haversineKm(PARIS, LYON);
    assert.ok(Math.abs(d - 392) < 3, `distance obtenue : ${d}`);
  });

  test('distance nulle pour un même point et symétrique', () => {
    assert.equal(haversineKm(PARIS, PARIS), 0);
    assert.equal(haversineKm(PARIS, LYON), haversineKm(LYON, PARIS));
  });

  test('accepte des coordonnées numériques sous forme de chaînes', () => {
    const d = haversineKm({ latitude: '48.857', longitude: '2.352' }, { latitude: '45.764', longitude: '4.836' });
    assert.ok(Math.abs(d - haversineKm(PARIS, LYON)) < 1e-9);
  });

  test('entrées absentes ou non numériques → null', () => {
    assert.equal(haversineKm(null, PARIS), null);
    assert.equal(haversineKm(PARIS, undefined), null);
    assert.equal(haversineKm({}, PARIS), null);
    assert.equal(haversineKm({ latitude: 'abc', longitude: 2 }, PARIS), null);
    assert.equal(haversineKm(PARIS, { latitude: 45 }), null);
    assert.equal(haversineKm(PARIS, { latitude: NaN, longitude: NaN }), null);
  });

  test('coordonnées null ou vides → null (et non la distance au point 0,0)', {
    todo: 'bug: Number(null) et Number("") valent 0, donc { latitude: null, longitude: null } est traité comme le point (0°, 0°)',
  }, () => {
    assert.equal(haversineKm({ latitude: null, longitude: null }, PARIS), null);
    assert.equal(haversineKm(PARIS, { latitude: '', longitude: '' }), null);
  });
});

describe('normalizeDepartement', () => {
  test('complète les codes à un chiffre : "1" → "01", 5 → "05"', () => {
    assert.equal(normalizeDepartement('1'), '01');
    assert.equal(normalizeDepartement(5), '05');
  });

  test('Corse en majuscules : "2a" → "2A", " 2b " → "2B"', () => {
    assert.equal(normalizeDepartement('2a'), '2A');
    assert.equal(normalizeDepartement(' 2b '), '2B');
  });

  test('conserve les codes à deux et trois chiffres : "75", 69, "971", "976"', () => {
    assert.equal(normalizeDepartement('75'), '75');
    assert.equal(normalizeDepartement(69), '69');
    assert.equal(normalizeDepartement('971'), '971');
    assert.equal(normalizeDepartement('976'), '976');
  });

  test('valeurs vides ou mal formées → null', () => {
    assert.equal(normalizeDepartement(null), null);
    assert.equal(normalizeDepartement(undefined), null);
    assert.equal(normalizeDepartement(''), null);
    assert.equal(normalizeDepartement('abc'), null);
    assert.equal(normalizeDepartement('2C'), null);
    assert.equal(normalizeDepartement('1000'), null);
    assert.equal(normalizeDepartement('75011'), null);
  });
});

describe('departementFromPostcode', () => {
  test('métropole : "75011" → "75", "01000" → "01", 69001 (nombre) → "69"', () => {
    assert.equal(departementFromPostcode('75011'), '75');
    assert.equal(departementFromPostcode('01000'), '01');
    assert.equal(departementFromPostcode(69001), '69');
  });

  test('Corse : "20090" → "2A", "20199" → "2A", "20200" → "2B", "20600" → "2B"', () => {
    assert.equal(departementFromPostcode('20090'), '2A');
    assert.equal(departementFromPostcode('20199'), '2A');
    assert.equal(departementFromPostcode('20200'), '2B');
    assert.equal(departementFromPostcode('20600'), '2B');
  });

  test('outre-mer sur trois chiffres : "97110" → "971", "97400" → "974", "97600" → "976"', () => {
    assert.equal(departementFromPostcode('97110'), '971');
    assert.equal(departementFromPostcode('97400'), '974');
    assert.equal(departementFromPostcode('97600'), '976');
  });

  test('trouve le code postal au milieu d\'un texte', () => {
    assert.equal(departementFromPostcode(' 95300 Pontoise '), '95');
    assert.equal(departementFromPostcode('F-75011 Paris'), '75');
  });

  test('entrées invalides → null : "abc", "7501", "750112", null', () => {
    assert.equal(departementFromPostcode('abc'), null);
    assert.equal(departementFromPostcode('7501'), null);
    assert.equal(departementFromPostcode('750112'), null);
    assert.equal(departementFromPostcode(null), null);
    assert.equal(departementFromPostcode(undefined), null);
  });
});

describe('postcodeFromAddress', () => {
  test('extrait le code postal d\'une adresse complète', () => {
    assert.equal(postcodeFromAddress('12 rue de la Roquette 75011 Paris'), '75011');
    assert.equal(postcodeFromAddress('Refuge SPA, 95300 Pontoise, France'), '95300');
  });

  test('renvoie le premier code à 5 chiffres et ignore les nombres plus longs', () => {
    assert.equal(postcodeFromAddress('Tél. 0612345678 — 69007 Lyon'), '69007');
    assert.equal(postcodeFromAddress('13001 Marseille (ou 13002)'), '13001');
  });

  test('aucun code postal → null', () => {
    assert.equal(postcodeFromAddress('Paris'), null);
    assert.equal(postcodeFromAddress(''), null);
    assert.equal(postcodeFromAddress(null), null);
    assert.equal(postcodeFromAddress(undefined), null);
  });
});

describe('departementCentre', () => {
  test('la table contient 101 départements', () => {
    assert.equal(Object.keys(DEPARTEMENTS).length, 101);
  });

  test('chef-lieu de Paris avec libellé et code', () => {
    assert.deepEqual(departementCentre('75'), {
      latitude: 48.857, longitude: 2.352, label: 'Paris (75)', departement: '75',
    });
  });

  test('normalise le code avant la recherche : "1" → Ain, "2a" → Ajaccio, 971 → Basse-Terre', () => {
    assert.equal(departementCentre('1').departement, '01');
    assert.match(departementCentre('1').label, /^Bourg-en-Bresse \(01\)$/);
    assert.equal(departementCentre('2a').label, 'Ajaccio (2A)');
    assert.equal(departementCentre(971).label, 'Basse-Terre (971)');
  });

  test('département inconnu ou invalide → null', () => {
    assert.equal(departementCentre('20'), null);
    assert.equal(departementCentre('99'), null);
    assert.equal(departementCentre('abc'), null);
    assert.equal(departementCentre(null), null);
  });
});

describe('departementsAutour', () => {
  const paris = departementCentre('75');

  test('Paris, 50 km + marge 25 : petite et grande couronne, sans Lyon', () => {
    const deps = departementsAutour(paris, 50, 25);
    for (const code of ['75', '92', '93', '94', '78', '91', '95', '77']) {
      assert.ok(deps.includes(code), `${code} devrait être inclus (obtenu : ${deps.join(',')})`);
    }
    assert.ok(!deps.includes('69'), 'le Rhône ne doit pas être inclus');
    assert.ok(!deps.includes('28'), 'Chartres (≈ 78 km) est hors de 50 + 25 km');
  });

  test('résultat trié et sans doublon', () => {
    const deps = departementsAutour(paris, 50, 25);
    assert.deepEqual(deps, [...deps].sort());
    assert.equal(new Set(deps).size, deps.length);
  });

  test('marge par défaut de 80 km appliquée si non fournie', () => {
    const deps = departementsAutour(paris, 0);
    assert.ok(deps.includes('28'), 'Chartres (≈ 78 km) est dans la marge par défaut');
    assert.ok(!deps.includes('27'), 'Évreux (≈ 90 km) est hors de la marge par défaut');
  });

  test('ajoute toujours le département du centre, même hors rayon', () => {
    const centre = { latitude: 0, longitude: 0, departement: '75' };
    assert.deepEqual(departementsAutour(centre, 10, 0), ['75']);
  });

  test('centre absent ou sans coordonnées → liste vide', () => {
    assert.deepEqual(departementsAutour(null, 50, 25), []);
    assert.deepEqual(departementsAutour({}, 50, 25), []);
  });
});

describe('geocodeAdresse', () => {
  test('succès : coordonnées, libellé et département depuis le code postal', async () => {
    const http = fauxHttp({ reponse: reponseApiAdresse() });
    const geo = await geocodeAdresse('75011 Paris', http);
    assert.deepEqual(geo, { latitude: 48.8593, longitude: 2.3795, label: '75011 Paris', departement: '75' });
    assert.equal(http.appels.length, 1);
    assert.equal(http.appels[0], 'https://api-adresse.data.gouv.fr/search/?q=75011%20Paris&limit=1');
  });

  test('sans code postal : département tiré du contexte ("2A, Corse-du-Sud, Corse")', async () => {
    const reponse = {
      features: [{
        geometry: { type: 'Point', coordinates: [8.7369, 41.9267] },
        properties: { label: 'Ajaccio', context: '2a, Corse-du-Sud, Corse' },
      }],
    };
    const http = fauxHttp({ reponse });
    const geo = await geocodeAdresse('Ajaccio', http);
    assert.equal(geo.departement, '2A');
    assert.equal(geo.latitude, 41.9267);
  });

  test('sans libellé : la requête sert de libellé', async () => {
    const reponse = { features: [{ geometry: { coordinates: [4.835, 45.758] }, properties: { postcode: '69002' } }] };
    const geo = await geocodeAdresse('Lyon', fauxHttp({ reponse }));
    assert.equal(geo.label, 'Lyon');
    assert.equal(geo.departement, '69');
  });

  test('réponse vide ou sans géométrie → null', async () => {
    assert.equal(await geocodeAdresse('Nulle-Part', fauxHttp({ reponse: { features: [] } })), null);
    assert.equal(await geocodeAdresse('Nulle-Part', fauxHttp({ reponse: {} })), null);
    assert.equal(await geocodeAdresse('Nulle-Part', fauxHttp({ reponse: null })), null);
    assert.equal(await geocodeAdresse('Nulle-Part', fauxHttp({ reponse: { features: [{ properties: {} }] } })), null);
  });

  test('exception du client http → null (pas de propagation)', async () => {
    const http = fauxHttp({ erreur: new Error('connection reset') });
    assert.equal(await geocodeAdresse('Paris', http), null);
    assert.equal(http.appels.length, 1);
  });

  test('requête vide ou client http absent → null sans appel réseau', async () => {
    const http = fauxHttp({ reponse: reponseApiAdresse() });
    assert.equal(await geocodeAdresse('', http), null);
    assert.equal(await geocodeAdresse(null, http), null);
    assert.equal(await geocodeAdresse('Paris', null), null);
    assert.equal(http.appels.length, 0);
  });

  test('coordonnées non numériques dans la réponse → null', {
    todo: 'bug: seule la présence de geometry.coordinates est vérifiée ; [] ou ["x","y"] donnent latitude/longitude NaN au lieu de null',
  }, async () => {
    assert.equal(await geocodeAdresse('Paris', fauxHttp({ reponse: { features: [{ geometry: { coordinates: [] } }] } })), null);
    assert.equal(await geocodeAdresse('Paris', fauxHttp({ reponse: { features: [{ geometry: { coordinates: ['x', 'y'] } }] } })), null);
  });
});

describe('resolveCentre', () => {
  test('coordonnées explicites prioritaires : aucun géocodage', async () => {
    const http = fauxHttp({ reponse: reponseApiAdresse() });
    const c = await resolveCentre({ latitude: 45.764, longitude: 4.836, ville: 'Lyon', code_postal: '69001' }, http);
    assert.deepEqual(c, { latitude: 45.764, longitude: 4.836, label: 'Lyon', departement: '69', methode: 'coordonnees' });
    assert.equal(http.appels.length, 0);
  });

  test('coordonnées en chaînes et sans ville ni code postal : libellé "lat,lon"', async () => {
    const c = await resolveCentre({ latitude: '43.6', longitude: '1.44' });
    assert.equal(c.latitude, 43.6);
    assert.equal(c.longitude, 1.44);
    assert.equal(c.label, '43.6,1.44');
    assert.equal(c.departement, null);
    assert.equal(c.methode, 'coordonnees');
  });

  test('coordonnée incomplète (longitude null) : passe au géocodage de la ville', async () => {
    const http = fauxHttp({ reponse: reponseApiAdresse() });
    const c = await resolveCentre({ latitude: 48.8, longitude: null, ville: 'Paris' }, http);
    assert.equal(c.methode, 'geocodage');
    assert.equal(http.appels.length, 1);
  });

  test('ville géocodée (code postal ajouté à la requête) avant le code postal', async () => {
    const http = fauxHttp({ reponse: reponseApiAdresse() });
    const c = await resolveCentre({ ville: 'Paris', code_postal: '75011', latitude: null, longitude: null }, http);
    assert.deepEqual(c, { latitude: 48.8593, longitude: 2.3795, label: '75011 Paris', departement: '75', methode: 'geocodage' });
    assert.equal(http.appels[0], 'https://api-adresse.data.gouv.fr/search/?q=75011%20Paris&limit=1');
  });

  test('géocodage en échec : message de log puis repli sur le chef-lieu du code postal', async () => {
    const logs = [];
    const http = fauxHttp({ erreur: new Error('connection reset') });
    const c = await resolveCentre({ ville: 'Pontoise', code_postal: '95300' }, http, (m) => logs.push(m));
    assert.deepEqual(c, { ...departementCentre('95'), methode: 'departement' });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /95300 Pontoise/);
  });

  test('ville sans client http : repli direct sur le code postal', async () => {
    const c = await resolveCentre({ ville: 'Ajaccio', code_postal: '20090' });
    assert.equal(c.methode, 'departement');
    assert.equal(c.departement, '2A');
    assert.equal(c.label, 'Ajaccio (2A)');
  });

  test('code postal seul → chef-lieu du département', async () => {
    const c = await resolveCentre({ code_postal: '69007' });
    assert.deepEqual(c, { latitude: 45.764, longitude: 4.836, label: 'Lyon (69)', departement: '69', methode: 'departement' });
  });

  test('rien d\'exploitable → erreur explicite', async () => {
    await assert.rejects(resolveCentre({}), /Impossible de déterminer le centre/);
    await assert.rejects(resolveCentre(), /Impossible de déterminer le centre/);
    await assert.rejects(resolveCentre({ code_postal: 'abc' }), /Impossible de déterminer le centre/);
    await assert.rejects(resolveCentre({ code_postal: '99999' }), /Impossible de déterminer le centre/);
  });

  test('ville introuvable et pas de code postal → erreur', async () => {
    const http = fauxHttp({ reponse: { features: [] } });
    await assert.rejects(resolveCentre({ ville: 'Nulle-Part' }, http), /Impossible de déterminer le centre/);
  });

  test('coordonnées vides ("") ignorées : repli sur le code postal au lieu du point (0, 0)', {
    todo: 'bug: Number("") vaut 0 et "" != null, donc latitude/longitude "" sont acceptées comme (0°, 0°) méthode "coordonnees"',
  }, async () => {
    const c = await resolveCentre({ latitude: '', longitude: '', code_postal: '75011' });
    assert.equal(c.methode, 'departement');
    assert.equal(c.departement, '75');
  });
});
