// Détection des portées (frères et sœurs).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLitters, annotateLitters, splitNames, countAnimals } from '../src/portees.js';
import { buildReport } from '../src/report.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const spa = (id, nom, extra = {}) => ({ id: `laspa:${id}`, source: 'laspa', source_label: 'La SPA', nom, url: `https://www.la-spa.fr/animal/${id}/`, reserve: false, age_mois: 3.3, date_naissance: '2026-06-15', date_publication: '2026-09-21', lieu: { slug: 'refuge-spa-de-gennevilliers-grammont', nom: 'La SPA - Refuge de Gennevilliers – Grammont', precision: 'exacte', distance_km: 11 }, ...extra });
const sc = (id, nom, extra = {}) => ({ id: `secondechance:${id}`, source: 'secondechance', source_label: 'Seconde Chance', nom, url: `https://www.secondechance.org/animal/chat-europeen-${id}`, reserve: false, age_mois: 2, date_naissance: null, date_publication: '2026-09-20', lieu: { nom: 'Sopranimaux', precision: 'departement', departement: '75', departements_adoption: ['75'] }, description: '', ...extra });

describe('splitNames / countAnimals', () => {
  test('annonces à plusieurs noms', () => {
    assert.deepEqual(splitNames('Dean et gareth'), ['Dean', 'gareth']);
    assert.deepEqual(splitNames('Kusmi, dumbo et galanga'), ['Kusmi', 'dumbo', 'galanga']);
    assert.deepEqual(splitNames('Bluma & Blue'), ['Bluma', 'Blue']);
    assert.equal(countAnimals({ nom: 'Baloo et bianca' }), 2);
  });
  test('un seul nom malgré les mentions parasites', () => {
    assert.deepEqual(splitNames('PERLE ( réservée )'), ['PERLE']);
    assert.deepEqual(splitNames('BLOOM PAB29240'), ['BLOOM']);
    assert.deepEqual(splitNames('Paolo – adoption sos'), ['Paolo']);
    assert.deepEqual(splitNames('Radis [chaton]'), ['Radis']);
    assert.equal(countAnimals({ nom: 'Bulle' }), 1);
    assert.equal(countAnimals({ nom: '' }), 1);
  });
});

describe('detectLitters', () => {
  test('même refuge + même date de naissance (± 3 jours) → portée forte ; refuge différent exclu', () => {
    const L = [spa(1, 'BLINIS'), spa(2, 'BRIOCHE', { date_naissance: '2026-06-17', reserve: true }), spa(3, 'PANCAKE'), spa(4, 'ORPHIE', { lieu: { slug: 'chamarande', nom: 'Chamarande' } }), spa(5, 'LOIN', { date_naissance: '2026-06-25' })];
    const { portees, parId } = detectLitters(L);
    assert.equal(portees.length, 1);
    const p = portees[0];
    assert.deepEqual(p.noms, ['BLINIS', 'BRIOCHE', 'PANCAKE']);
    assert.equal(p.taille, 3);
    assert.equal(p.disponibles, 2);
    assert.equal(p.confiance, 'forte');
    assert.equal(p.date_naissance, '2026-06-15');
    assert.ok(p.indices.includes('même date de naissance'));
    assert.equal(parId.get('laspa:4'), undefined);
    assert.equal(parId.get('laspa:5'), undefined);
  });

  test('tolérance configurable : 0 jour sépare des dates différentes', () => {
    const L = [spa(1, 'A'), spa(2, 'B', { date_naissance: '2026-06-16' })];
    assert.equal(detectLitters(L, { tolerance_jours: 0 }).portees.length, 0);
    assert.equal(detectLitters(L, { tolerance_jours: 1 }).portees.length, 1);
  });

  test('nom d\'une autre annonce cité dans la description (même association) → portée forte', () => {
    const L = [sc(1, 'Mia', { description: 'Mia est la sœur de Tom, tous deux adorables.' }), sc(2, 'Tom', { date_publication: '2026-09-18' }), sc(3, 'Lili', { lieu: { nom: 'Autre asso', precision: 'departement', departement: '75' }, description: 'Lili adore Tom, le chien de la maison.' })];
    const { portees, parId } = detectLitters(L);
    assert.equal(portees.length, 1);
    assert.deepEqual(portees[0].noms, ['Mia', 'Tom']);
    assert.equal(portees[0].confiance, 'forte');
    assert.ok(portees[0].indices.some((i) => i.includes('Tom')));
    assert.ok(portees[0].indices.includes('fratrie mentionnée'));
    assert.equal(parId.get('secondechance:3'), undefined, 'association différente : pas reliée');
  });

  test('nom trop court ou mot courant non pris comme indice (« Chat », « Bebe »)', () => {
    const L = [sc(1, 'Chat', { description: 'Un chat très doux.' }), sc(2, 'Ba', { description: 'Ba ba ba.' }), sc(3, 'Bebe', { description: 'Un bebe adorable.' })];
    // sans date de naissance ni date de publication commune différente : seuls les indices 3 (même âge + même date) relient
    const { portees } = detectLitters(L.map((l, i) => ({ ...l, date_publication: `2026-09-1${i}` })));
    assert.equal(portees.length, 0);
  });

  test('sans date de naissance : même âge affiché et même date de mise en ligne → portée probable', () => {
    const L = [sc(1, 'Baya'), sc(2, 'Baby'), sc(3, 'Vieux', { age_mois: 5 }), sc(4, 'Autre jour', { date_publication: '2026-09-01' })];
    const { portees } = detectLitters(L);
    assert.equal(portees.length, 1);
    assert.deepEqual(portees[0].noms, ['Baby', 'Baya']);
    assert.equal(portees[0].confiance, 'probable');
  });

  test('annonce à plusieurs noms = portée à elle seule, comptée pour plusieurs chatons', () => {
    const L = [sc(1, 'Dean et gareth', { date_publication: '2026-08-01' })];
    const { portees } = detectLitters(L);
    assert.equal(portees.length, 1);
    assert.equal(portees[0].taille, 2);
    assert.equal(portees[0].annonces, 1);
    assert.ok(portees[0].indices[0].startsWith('annonce groupée'));
  });

  test('taille_min : une paire est ignorée si l\'on exige 3 chatons', () => {
    const L = [spa(1, 'A'), spa(2, 'B')];
    assert.equal(detectLitters(L, { taille_min: 3 }).portees.length, 0);
    assert.equal(detectLitters(L, { taille_min: 2 }).portees.length, 1);
  });

  test('tri : plus grande portée d\'abord, puis la plus jeune', () => {
    const L = [spa(1, 'A'), spa(2, 'B'), sc(3, 'C', { age_mois: 1 }), sc(4, 'D', { age_mois: 1 }), sc(5, 'E', { age_mois: 1 })];
    const { portees } = detectLitters(L);
    assert.deepEqual(portees.map((p) => p.taille), [3, 2]);
  });

  test('annotateLitters pose listing.portee (ou null) et retourne les portées', () => {
    const L = [spa(1, 'A'), spa(2, 'B'), spa(3, 'Seul', { lieu: { slug: 'x', nom: 'X' } })];
    const portees = annotateLitters(L);
    assert.equal(portees.length, 1);
    assert.equal(L[0].portee.id, portees[0].id);
    assert.equal(L[0].portee.taille, 2);
    assert.equal(L[2].portee, null);
  });
});

describe('rapport avec portées', () => {
  const config = { ...DEFAULT_CONFIG, portees: { ...DEFAULT_CONFIG.portees } };
  const zone = { mode: 'rayon', label: '50 km autour de Paris', centre: { latitude: 48.86, longitude: 2.35 }, rayon_km: 50, departements: [] };
  const NOW = new Date(Date.UTC(2026, 8, 24, 12));

  test('les chatons d\'une portée sont regroupés sous un titre, les autres sous « Chatons seuls »', () => {
    const kittens = [spa(1, 'BLINIS'), spa(2, 'BRIOCHE'), spa(3, 'SEUL', { lieu: { slug: 'x', nom: 'Refuge X' }, date_naissance: '2026-07-01' })];
    const portees = annotateLitters(kittens);
    const r = buildReport({ kittens, newcomers: [], portees, config, zone, now: NOW });
    assert.match(r.markdown, /### 👨‍👩‍👧‍👦 Portée de 2 chatons · La SPA - Refuge de Gennevilliers – Grammont · né·e·s le 15\/06\/2026/);
    assert.match(r.markdown, /### Chatons seuls \(1\)/);
    assert.ok(r.markdown.indexOf('BLINIS') < r.markdown.indexOf('Chatons seuls') && r.markdown.indexOf('Chatons seuls') < r.markdown.indexOf('SEUL'));
    assert.match(r.text, /▶ Portée de 2 chatons/);
    assert.match(r.html, /<u>👨‍👩‍👧‍👦 Portée de 2 chatons/);
    assert.equal(r.json.portees.length, 1);
    assert.equal(r.compte.portees, 1);
  });

  test('sans portée détectée : rendu inchangé (pas de sous-titres)', () => {
    const kittens = [spa(1, 'A'), spa(2, 'B', { lieu: { slug: 'y', nom: 'Y' }, date_naissance: '2026-08-01' })];
    const r = buildReport({ kittens, newcomers: [], portees: [], config, zone, now: NOW });
    assert.doesNotMatch(r.markdown, /Chatons seuls|Portée de/);
    assert.equal(r.compte.portees, 0);
  });

  test('portée probable et réservés : mention « (1 disponible) » et « portée probable »', () => {
    const kittens = [sc(1, 'Baya', { reserve: true }), sc(2, 'Baby')];
    const portees = annotateLitters(kittens);
    const r = buildReport({ kittens, newcomers: [], portees, config, zone, now: NOW });
    assert.match(r.text, /Portée de 2 chatons \(1 disponible\) · Sopranimaux · 2 mois · portée probable/);
  });
});
