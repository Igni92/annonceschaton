// Tests de src/sources/secondechance.js (scraping HTML de secondechance.org).
// Données : copies de pages réelles dans test/fixtures/secondechance_*.html
//   - secondechance_recherche.html : species=2&department=41 (Paris)&ageRanges[0]=1 → 52 résultats,
//     12 cartes chat puis une carte « Coup de coeur » (gerbille) à exclure ;
//   - secondechance_fiche.html : Sweety, né le 01/03/2026, mis à jour le 24/09/2026, asso AFELP (95300 Pontoise).
// Aucun accès réseau : fetchSecondeChance reçoit un faux client http ({ getJson, getText }) qui route selon l'URL ;
// « maintenant » est toujours figé.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SC_BASE,
  SC_DEPARTEMENTS,
  applyFiche,
  buildSearchUrl,
  departementsPourZone,
  fetchSecondeChance,
  mapCard,
  parseFichePage,
  parseSearchPage,
} from '../src/sources/secondechance.js';
import { DEFAULT_CONFIG, deepMerge } from '../src/config.js';
import { buildZone } from '../src/filters.js';
import { departementsAutour } from '../src/geo.js';
import { emptyState } from '../src/state.js';

// ---------------------------------------------------------------------------
// Fixtures et utilitaires
// ---------------------------------------------------------------------------

const lireFixture = (nom) => readFileSync(new URL(`./fixtures/${nom}`, import.meta.url), 'utf8');
const RECHERCHE = lireFixture('secondechance_recherche.html');
const FICHE = lireFixture('secondechance_fiche.html');

/** Page au-delà de la dernière : même gabarit (compteur, « Coup de coeur » gerbille) mais aucune carte de résultat. */
const PAGE_VIDE = RECHERCHE.replace(/<main[\s\S]*?<\/main>/, '<main></main>');

const NOW = new Date('2026-09-24T12:00:00Z');
const PARIS = { latitude: 48.857, longitude: 2.352 };
const JOUR_MS = 86_400_000;

/** Âge en mois pour un nombre de jours (même convention que src/age.js : 365,25 / 12 jours par mois). */
const mois = (jours) => jours / (365.25 / 12);
const presque = (actuel, attendu, msg) => assert.ok(Math.abs(actuel - attendu) < 1e-9, `${msg ?? ''} ${actuel} ≠ ${attendu}`);

const CARTES = parseSearchPage(RECHERCHE).cards;
const IDS = CARTES.map((c) => c.id);
const carte = (nom) => {
  const c = CARTES.find((x) => x.nom === nom);
  assert.ok(c, `carte ${nom} absente de la fixture`);
  return structuredClone(c);
};

/** Page de recherche synthétique (même balisage que le site), suivie d'une carte « Coup de coeur » (chat) à exclure. */
function pageAvecCartes(cartesHtml, total = 1) {
  return `<div class="col-span-1">${total} résultats trouvés</div>
<main class="flex flex-wrap">${cartesHtml}</main>
<!-- Coup de coeur -->
<h2 class="content-title">Coup de coeur</h2>
<a href="https://www.secondechance.org/animal/chat-europeen-vedette-1400000"><h3>Vedette</h3><h4>Asso (13)</h4><p>EUROPÉEN Mâle - 5 ans</p></a>`;
}
function carteHtml({ slug, id, nom, asso, info, image = 'https://www.secondechance.org/uploads/anim/x.jpg' }) {
  return `<div class="p-6"><a href="https://www.secondechance.org/animal/${slug}-${id}" class="!text-gray-dark-sc">
  <img src="${image}" alt="" />
  <h3 class="pacifico-regular">
      ${nom}
  </h3>
  <h4 class="open-sans font-bold">
      ${asso}
  </h4>
  <p class="open-sans text-sm">${info}</p>
</a></div>`;
}
/** Carte synthétique de Sweety (le chat de la fiche), telle que décrite dans docs/SOURCES.md. */
const SWEETY = parseSearchPage(pageAvecCartes(carteHtml({
  slug: 'chat-europeen-sweety', id: 1519459, nom: 'Sweety', asso: 'AFELP (95)', info: 'EUROPÉEN Mâle - 6 mois',
}))).cards[0];

/** Configuration complète (valeurs par défaut + surcharges). */
function configSC({ zone = { mode: 'departements', departements: ['75'] }, age_max_mois = 4, sc = {}, nouveaux = {} } = {}) {
  return deepMerge(DEFAULT_CONFIG, { zone, age_max_mois, sources: { secondechance: sc }, nouveaux_arrivants: nouveaux });
}

/**
 * Faux client http : route les recherches (/animal/recherche) et les fiches, mémorise les URL demandées.
 * Par défaut : la fixture pour la page 1, une page vide ensuite ; la fiche de Sweety pour toute fiche.
 */
function fauxHttp({ recherche = (u, page) => (page === 1 ? RECHERCHE : PAGE_VIDE), fiche = () => FICHE } = {}) {
  const appels = [];
  const estRecherche = (url) => new URL(url).pathname === '/animal/recherche';
  return {
    appels,
    recherches: () => appels.filter(estRecherche).map((u) => new URL(u)),
    fiches: () => appels.filter((u) => !estRecherche(u)),
    async getText(url) {
      appels.push(url);
      const u = new URL(url);
      if (u.pathname === '/animal/recherche') return recherche(u, Number(u.searchParams.get('page') ?? 1));
      return fiche(u);
    },
    async getJson(url) {
      throw new Error(`getJson inattendu : ${url}`);
    },
  };
}
const estRechercheChatons = (u) => u.searchParams.has('ageRanges[0]');
const pageDe = (u) => Number(u.searchParams.get('page') ?? 1);

/** Lance fetchSecondeChance avec une zone construite sans réseau. */
async function lancer({ config = configSC(), state = emptyState(), http = fauxHttp(), context = {} } = {}) {
  const zone = await buildZone(config);
  const logs = [];
  const res = await fetchSecondeChance({ http, config, state, zone, now: NOW, log: (m) => logs.push(m), context });
  return { ...res, http, state, logs };
}

/** État où les annonces `ids` ont déjà été vues. */
function etatAvecVus(ids) {
  const state = emptyState();
  for (const id of ids) state.vus[`secondechance:${id}`] = { premiere_vue: '2026-09-20T06:00:00.000Z', derniere_vue: '2026-09-23T06:00:00.000Z' };
  return state;
}

// ---------------------------------------------------------------------------
// buildSearchUrl
// ---------------------------------------------------------------------------

describe('buildSearchUrl', () => {
  test('recherche minimale : espèce chat uniquement, sans page ni département', () => {
    assert.equal(buildSearchUrl(), `${SC_BASE}/animal/recherche?species=2`);
  });

  test('département + tranches d\'âge : même URL que les liens du site (ageRanges%5B0%5D=1)', () => {
    const url = buildSearchUrl({ departementId: 41, ageRanges: [1] });
    assert.equal(url, 'https://www.secondechance.org/animal/recherche?species=2&department=41&ageRanges%5B0%5D=1');
    assert.ok(RECHERCHE.includes('species=2&amp;department=41&amp;ageRanges%5B0%5D=1'), 'format repris des liens de la fixture');
    const u = new URL(url);
    assert.equal(u.searchParams.get('ageRanges[0]'), '1');
    assert.equal(u.searchParams.has('page'), false);
    // Plusieurs tranches : ageRanges[0], ageRanges[1]…
    const deux = new URL(buildSearchUrl({ departementId: 41, ageRanges: [1, 2] }));
    assert.equal(deux.searchParams.get('ageRanges[0]'), '1');
    assert.equal(deux.searchParams.get('ageRanges[1]'), '2');
  });

  test('page > 1 ajoutée (identique au lien « page 2 » de la fixture), page 1 omise ; option hors département', () => {
    assert.equal(
      buildSearchUrl({ departementId: 41, ageRanges: [1], page: 2 }),
      `${SC_BASE}/animal/recherche?species=2&department=41&ageRanges%5B0%5D=1&page=2`,
    );
    assert.ok(RECHERCHE.includes('href="/animal/recherche?species=2&amp;department=41&amp;ageRanges%5B0%5D=1&amp;page=2"'));
    assert.equal(new URL(buildSearchUrl({ page: 1 })).searchParams.has('page'), false);
    assert.equal(new URL(buildSearchUrl({ page: 5 })).searchParams.get('page'), '5');
    // adoptableOutsideDepartment=1 seulement si demandé.
    assert.equal(new URL(buildSearchUrl({ departementId: 41, adoptableOutsideDepartment: true })).searchParams.get('adoptableOutsideDepartment'), '1');
    assert.equal(new URL(buildSearchUrl({ departementId: 41 })).searchParams.has('adoptableOutsideDepartment'), false);
  });
});

// ---------------------------------------------------------------------------
// parseSearchPage
// ---------------------------------------------------------------------------

describe('parseSearchPage (fixture réelle, Paris, tranche Bébé)', () => {
  test('total 52 et 12 cartes, toutes des chats ; carte « Coup de coeur » (gerbille) exclue', () => {
    const { total, cards } = parseSearchPage(RECHERCHE);
    assert.equal(total, 52);
    assert.equal(cards.length, 12);
    assert.ok(cards.every((c) => c.espece === 'chat'));
    // La carte « Coup de coeur » (gerbille Elya), présente dans la page, est exclue.
    assert.ok(RECHERCHE.includes('gerbille-gerbille-de-mongolie-elya-1474068'), 'la fixture contient bien la gerbille');
    assert.ok(!IDS.includes('1474068'));
    assert.ok(!CARTES.some((c) => c.nom === 'Elya' || /gerbille/i.test(`${c.espece} ${c.race}`)));
  });

  test('champs complets de la première carte (Bulle)', () => {
    assert.deepEqual(CARTES[0], {
      id: '1519230',
      url: 'https://www.secondechance.org/animal/chat-europeen-bulle-1519230',
      slug: 'chat-europeen-bulle-1519230',
      nom: 'Bulle',
      association: '4 pattes en danger',
      departement: '75',
      race: 'EUROPÉEN',
      sexe: 'femelle',
      age_texte: '3 mois',
      age_mois: 3,
      image: 'https://www.secondechance.org/uploads/anim/6ab44bfeaedf6705039431.jpg',
      espece: 'chat',
    });
  });

  test('toutes les cartes : département 75, sexe, âge de 2 à 4 mois, id = dernier nombre de l\'URL, ordre décroissant', () => {
    const kawa = carte('Kawa');
    assert.equal(kawa.sexe, 'male');
    assert.equal(kawa.age_texte, '2 mois');
    assert.equal(kawa.age_mois, 2);
    assert.ok(CARTES.some((c) => c.association === 'Les petits protégés de Jo & Co'), '&amp; décodé');
    assert.ok(CARTES.some((c) => c.nom === 'Chatonne écaille (et...'), 'nom tronqué par le site conservé');
    for (const c of CARTES) {
      assert.equal(c.departement, '75', c.nom);
      assert.equal(c.race, 'EUROPÉEN', c.nom);
      assert.ok(['male', 'femelle'].includes(c.sexe), c.nom);
      assert.equal(c.age_mois, Number.parseInt(c.age_texte, 10), c.nom);
      assert.ok(c.age_mois >= 2 && c.age_mois <= 4, c.nom);
      assert.ok(c.url.endsWith(`-${c.id}`), c.url);
      assert.match(c.image, /^https:\/\/www\.secondechance\.org\/uploads\/anim\//);
    }
    const nums = IDS.map(Number);
    assert.deepEqual(nums, [...nums].sort((a, b) => b - a), 'plus récent d\'abord');
    assert.equal(new Set(IDS).size, IDS.length);
  });

  test('carte sans âge, département « 2A », association sans département', () => {
    const html = pageAvecCartes([
      carteHtml({ slug: 'chat-europeen-nala', id: 10, nom: 'Nala', asso: 'Chats de Corse (2A)', info: 'EUROPÉEN Femelle' }),
      carteHtml({ slug: 'chat-siamois-tom', id: 11, nom: 'Tom', asso: 'Particulier', info: 'SIAMOIS Mâle - 6 semaines' }),
    ].join('\n'), 2);
    const { total, cards } = parseSearchPage(html);
    assert.equal(total, 2);
    assert.equal(cards.length, 2, 'la carte « Coup de coeur » (Vedette) est exclue');
    const [nala, tom] = cards;
    assert.equal(nala.departement, '2A');
    assert.equal(nala.association, 'Chats de Corse');
    assert.equal(nala.sexe, 'femelle');
    assert.equal(nala.age_texte, null);
    assert.equal(nala.age_mois, null);
    assert.equal(tom.association, 'Particulier');
    assert.equal(tom.departement, null);
    assert.equal(tom.race, 'SIAMOIS');
    presque(tom.age_mois, mois(42));
  });

  test('page vide ou absente : total inconnu, aucune carte', () => {
    assert.deepEqual(parseSearchPage(''), { total: null, cards: [] });
    assert.deepEqual(parseSearchPage(null), { total: null, cards: [] });
    assert.deepEqual(parseSearchPage(PAGE_VIDE), { total: 52, cards: [] });
  });
});

// ---------------------------------------------------------------------------
// parseFichePage
// ---------------------------------------------------------------------------

describe('parseFichePage (fiche réelle de Sweety)', () => {
  const fiche = parseFichePage(FICHE);

  test('dates (naissance 2026-03-01, mise à jour 2026-09-24) et attributs : âge, sexe, race, pelage, taille', () => {
    assert.equal(fiche.date_naissance, '2026-03-01');
    assert.equal(fiche.date_maj, '2026-09-24');
    assert.equal(fiche.age_texte, '6 mois');
    assert.equal(fiche.sexe, 'male');
    assert.equal(fiche.race, 'EUROPÉEN');
    assert.equal(fiche.pelage, 'Ras');
    assert.equal(fiche.taille, 'Moyen');
    assert.equal(typeof fiche.couleur, 'string');
  });

  test('association : AFELP, 95300 Pontoise, département 95, lien refuge', () => {
    assert.deepEqual(fiche.association, {
      nom: 'AFELP',
      url: 'https://www.secondechance.org/refuge/val-d-oise/afelp-1304',
      code_postal: '95300',
      ville: 'Pontoise',
      departement: '95',
    });
  });

  test('description : texte brut de la section « Présentation », tronqué à 400 caractères', () => {
    assert.match(fiche.description, /^Sweety/);
    assert.ok(fiche.description.length <= 400);
    assert.ok(!/[<>]/.test(fiche.description), 'aucune balise HTML');
  });

  test('page vide : tous les champs à null', () => {
    const vide = parseFichePage('');
    assert.equal(vide.date_naissance, null);
    assert.equal(vide.date_maj, null);
    assert.equal(vide.age_texte, null);
    assert.equal(vide.sexe, null);
    assert.equal(vide.description, null);
    assert.deepEqual(vide.association, { nom: null, url: null, code_postal: null, ville: null, departement: null });
  });
});

// ---------------------------------------------------------------------------
// mapCard / applyFiche
// ---------------------------------------------------------------------------

describe('mapCard', () => {
  test('recherche par département : département = celui de la recherche, association inconnue', () => {
    const l = mapCard(carte('Bulle'), '92', NOW);
    assert.equal(l.id, 'secondechance:1519230');
    assert.equal(l.source, 'secondechance');
    assert.equal(l.source_id, '1519230');
    assert.equal(l.uid, 'chat-europeen-bulle-1519230');
    assert.equal(l.nom, 'Bulle');
    assert.equal(l.espece, 'chat');
    assert.equal(l.age_mois, 3);
    assert.equal(l.date_naissance, null);
    assert.equal(l.date_publication, null);
    assert.equal(l.reserve, false);
    assert.equal(l.fiche_lue, false);
    assert.equal(l.lieu.nom, '4 pattes en danger');
    assert.equal(l.lieu.departement, '92');
    assert.equal(l.lieu.departement_association, null);
    assert.deepEqual([...l.lieu.departements_adoption], ['92']);
    assert.equal(l.lieu.precision, 'departement');
    assert.equal(l.lieu.latitude, null);
    assert.equal(l.lieu.longitude, null);
    assert.equal(l.lieu.distance_km, null);
  });

  test('sans département de recherche (France entière) : département de la carte = association', () => {
    const l = mapCard(carte('Bulle'), null, NOW);
    assert.equal(l.lieu.departement, '75');
    assert.equal(l.lieu.departement_association, '75');
    assert.deepEqual([...l.lieu.departements_adoption], ['75']);
  });

  test('« réservé(e) » dans le nom → reserve = true', () => {
    assert.equal(mapCard({ ...carte('Kawa'), nom: 'Kawa (réservé)' }, '75').reserve, true);
    assert.equal(mapCard({ ...carte('Baya'), nom: 'BAYA RESERVEE' }, '75').reserve, true);
    assert.equal(mapCard(carte('Baya'), '75').reserve, false);
  });
});

describe('applyFiche', () => {
  const FICHE_SWEETY = parseFichePage(FICHE);

  test('ne remplace pas le département d\'adoption, renseigne le département et le siège de l\'association', () => {
    const l = applyFiche(mapCard(SWEETY, '75', NOW), FICHE_SWEETY, NOW);
    assert.equal(l.lieu.departement, '75', 'reste le département de recherche (adoptable à Paris)');
    assert.equal(l.lieu.departement_association, '95');
    assert.equal(l.lieu.ville, 'Pontoise');
    assert.equal(l.lieu.code_postal, '95300');
    assert.equal(l.lieu.url, 'https://www.secondechance.org/refuge/val-d-oise/afelp-1304');
    assert.equal(l.lieu.nom, 'AFELP');
    assert.deepEqual([...l.lieu.departements_adoption], ['75']);
    assert.equal(l.fiche_lue, true);
  });

  test('date de naissance → âge précis ; date de mise à jour → date_publication', () => {
    const l = applyFiche(mapCard(SWEETY, '75', NOW), FICHE_SWEETY, NOW);
    assert.equal(l.date_naissance, '2026-03-01');
    assert.equal(l.date_publication, '2026-09-24');
    presque(l.age_mois, mois((NOW.getTime() - Date.UTC(2026, 2, 1)) / JOUR_MS));
    assert.equal(l.age_texte, '6 mois');
    assert.match(l.description, /^Sweety/);
  });

  test('sans date de naissance : âge repris du texte ; sexe/race/âge de la fiche si la carte n\'en a pas', () => {
    const l = mapCard({ ...SWEETY, sexe: null, race: null, age_texte: null, age_mois: null }, '75', NOW);
    applyFiche(l, { ...FICHE_SWEETY, date_naissance: null }, NOW);
    assert.equal(l.date_naissance, null);
    assert.equal(l.age_texte, '6 mois');
    assert.equal(l.age_mois, 6);
    assert.equal(l.sexe, 'male');
    assert.equal(l.race, 'EUROPÉEN');
  });

  test('département inconnu (France entière, carte sans département) : repris de l\'association', () => {
    const l = mapCard({ ...SWEETY, departement: null }, null, NOW);
    assert.equal(l.lieu.departement, null);
    applyFiche(l, FICHE_SWEETY, NOW);
    assert.equal(l.lieu.departement, '95');
    assert.equal(l.lieu.departement_association, '95');
  });

  test('fiche absente : annonce inchangée', () => {
    const l = mapCard(SWEETY, '75', NOW);
    const avant = structuredClone(l);
    assert.equal(applyFiche(l, null, NOW), l);
    assert.deepEqual(l, avant);
  });
});

// ---------------------------------------------------------------------------
// departementsPourZone
// ---------------------------------------------------------------------------

describe('departementsPourZone', () => {
  const config = configSC();

  test('mode « departements » : la liste de la zone', () => {
    assert.deepEqual(departementsPourZone({ mode: 'departements', departements: ['75', '92'] }, config), ['75', '92']);
  });

  test('mode « rayon » : chefs-lieux à moins de rayon + marge (25 km si absente)', () => {
    const zone = { mode: 'rayon', centre: PARIS, rayon_km: 50, marge_departement_km: 25 };
    const deps = departementsPourZone(zone, config);
    assert.deepEqual(deps, departementsAutour(PARIS, 50, 25));
    assert.ok(deps.includes('75') && deps.includes('95'));
    assert.ok(!deps.includes('69'));
    assert.deepEqual(departementsPourZone({ mode: 'rayon', centre: PARIS, rayon_km: 5 }, config), departementsAutour(PARIS, 5, 25));
    assert.deepEqual(departementsPourZone({ mode: 'rayon', centre: PARIS, rayon_km: 5, marge_departement_km: 0 }, config), ['75']);
  });

  test('mode « france » : une seule recherche sans département', () => {
    assert.deepEqual(departementsPourZone({ mode: 'france' }, config), [null]);
  });

  test('surcharge sources.secondechance.departements : prioritaire et normalisée', () => {
    const force = configSC({ sc: { departements: ['1', '2a', 75] } });
    assert.deepEqual(departementsPourZone({ mode: 'france' }, force), ['01', '2A', '75']);
    assert.deepEqual(departementsPourZone({ mode: 'departements', departements: ['13'] }, force), ['01', '2A', '75']);
    assert.deepEqual(departementsPourZone({ mode: 'rayon', centre: PARIS, rayon_km: 50 }, force), ['01', '2A', '75']);
    // Liste vide : ignorée, on revient à la zone.
    assert.deepEqual(departementsPourZone({ mode: 'departements', departements: ['13'] }, configSC({ sc: { departements: [] } })), ['13']);
  });
});

// ---------------------------------------------------------------------------
// fetchSecondeChance (faux http)
// ---------------------------------------------------------------------------

describe('fetchSecondeChance : pagination', () => {
  test('page 1 puis page vide : arrêt de la pagination (2 pages par recherche)', async () => {
    const { listings, stats, http } = await lancer({ config: configSC({ sc: { fiches_details: false } }) });
    const recherches = http.recherches();
    assert.equal(recherches.length, 4);
    const chatons = recherches.filter(estRechercheChatons);
    const tousAges = recherches.filter((u) => !estRechercheChatons(u));
    assert.deepEqual(chatons.map(pageDe), [1, 2]);
    assert.deepEqual(tousAges.map(pageDe), [1, 2]);
    assert.ok(recherches.every((u) => u.searchParams.get('department') === '41' && u.searchParams.get('species') === '2'));
    assert.ok(chatons.every((u) => u.searchParams.get('ageRanges[0]') === '1' && !u.searchParams.has('ageRanges[1]')));
    assert.equal(stats.pages, 4);
    assert.equal(stats.cartes, 24);
    assert.equal(stats.departements, 1);
    assert.equal(stats.pages_tronquees, 0);
    assert.equal(stats.erreurs, 0);
    assert.equal(listings.length, 12, 'mêmes cartes dans les deux recherches : dédoublonnées');
    assert.deepEqual(listings.map((l) => l.id).sort(), IDS.map((id) => `secondechance:${id}`).sort());
    assert.equal(stats.dans_zone, 12);
  });

  test('le total (52 résultats, 12 par page) borne la pagination à 5 pages ; pages_max la tronque', async () => {
    const http = fauxHttp({ recherche: () => RECHERCHE });
    const { stats } = await lancer({ config: configSC({ sc: { fiches_details: false } }), http });
    assert.deepEqual(http.recherches().filter(estRechercheChatons).map(pageDe), [1, 2, 3, 4, 5]);
    assert.equal(stats.pages, 10);
    assert.equal(stats.pages_tronquees, 0);
    // pages_max = 2 : lecture limitée, comptée dans pages_tronquees (une par recherche).
    const { stats: tronque } = await lancer({ config: configSC({ sc: { fiches_details: false, pages_max: 2 } }), http: fauxHttp({ recherche: () => RECHERCHE }) });
    assert.equal(tronque.pages, 4);
    assert.equal(tronque.pages_tronquees, 2);
  });

  test('stopWhenKnown : toutes les cartes déjà vues → une seule page tous âges (une inconnue suffit à continuer)', async () => {
    const http = fauxHttp({ recherche: () => RECHERCHE });
    await lancer({ config: configSC({ sc: { fiches_details: false } }), http, state: etatAvecVus(IDS) });
    assert.deepEqual(http.recherches().filter((u) => !estRechercheChatons(u)).map(pageDe), [1]);
    // La recherche des chatons, elle, lit toujours toutes les pages.
    assert.deepEqual(http.recherches().filter(estRechercheChatons).map(pageDe), [1, 2, 3, 4, 5]);
    // Une seule carte jamais vue suffit à poursuivre la recherche tous âges.
    const http2 = fauxHttp({ recherche: () => RECHERCHE });
    await lancer({ config: configSC({ sc: { fiches_details: false } }), http: http2, state: etatAvecVus(IDS.slice(1)) });
    assert.deepEqual(http2.recherches().filter((u) => !estRechercheChatons(u)).map(pageDe), [1, 2, 3, 4, 5]);
  });

  test('tranches d\'âge selon age_max_mois, recherche tous âges désactivable, hors département', async () => {
    const tranches = async (age_max_mois, extra = {}) => {
      const { http } = await lancer({ config: configSC({ age_max_mois, sc: { fiches_details: false, ...extra.sc }, nouveaux: extra.nouveaux }) });
      return http;
    };
    const ages = (u) => [...u.searchParams.keys()].filter((k) => k.startsWith('ageRanges')).map((k) => u.searchParams.get(k));
    assert.deepEqual(ages((await tranches(4)).recherches()[0]), ['1']);
    assert.deepEqual(ages((await tranches(12)).recherches()[0]), ['1', '2']);
    assert.deepEqual(ages((await tranches(36)).recherches()[0]), ['1', '2', '3', '4']);

    const sansTousAges = await tranches(4, { nouveaux: { tous_ages: false } });
    assert.ok(sansTousAges.recherches().every(estRechercheChatons), 'aucune recherche tous âges');

    const horsDep = await tranches(4, { sc: { adoptable_hors_departement: true } });
    assert.ok(horsDep.recherches().every((u) => u.searchParams.get('adoptableOutsideDepartment') === '1'));
  });
});

describe('fetchSecondeChance : zone et départements', () => {
  test('animal trouvé dans le 75 et le 92 : departements_adoption converti en tableau trié', async () => {
    const config = configSC({ zone: { mode: 'departements', departements: ['92', '75'] }, sc: { fiches_details: false } });
    const { listings, stats, http } = await lancer({ config });
    assert.deepEqual([...new Set(http.recherches().map((u) => u.searchParams.get('department')))], ['45', '41']);
    assert.equal(stats.departements, 2);
    assert.equal(listings.length, 12);
    for (const l of listings) {
      assert.ok(Array.isArray(l.lieu.departements_adoption), 'Set converti en tableau');
      assert.deepEqual(l.lieu.departements_adoption, ['75', '92']);
      assert.equal(l.lieu.departement, '92', 'premier département de recherche où l\'animal a été trouvé');
      assert.equal(l.lieu.departement_association, null);
      assert.equal(l.lieu.precision, 'departement');
    }
    assert.doesNotThrow(() => JSON.stringify(listings));
    assert.deepEqual(JSON.parse(JSON.stringify(listings[0])).lieu.departements_adoption, ['75', '92']);
  });

  test('France entière : une seule recherche sans département, département de la carte', async () => {
    const config = configSC({ zone: { mode: 'france' }, sc: { fiches_details: false } });
    const { listings, stats, http } = await lancer({ config });
    assert.ok(http.recherches().every((u) => !u.searchParams.has('department')));
    assert.equal(stats.departements, 0);
    assert.equal(listings.length, 12);
    for (const l of listings) {
      assert.equal(l.lieu.departement, '75');
      assert.equal(l.lieu.departement_association, '75');
      assert.deepEqual(l.lieu.departements_adoption, ['75']);
    }
  });

  test('mode rayon : départements déduits du centre, annonces du 75 dans la zone', async () => {
    const config = configSC({ zone: { mode: 'rayon', centre: { ...PARIS, ville: 'Paris' }, rayon_km: 5, marge_departement_km: 0 }, sc: { fiches_details: false } });
    const { listings, http } = await lancer({ config });
    assert.deepEqual([...new Set(http.recherches().map((u) => u.searchParams.get('department')))], [String(SC_DEPARTEMENTS['75'].id)]);
    assert.equal(listings.length, 12);
  });

  test('département inconnu du site : ignoré avec un message, les autres sont interrogés', async () => {
    const config = configSC({ zone: { mode: 'departements', departements: ['977', '75'] }, sc: { fiches_details: false } });
    const { listings, logs, http } = await lancer({ config });
    assert.ok(logs.some((m) => m.includes('977') && m.includes('inconnu')), logs.join('\n'));
    assert.deepEqual([...new Set(http.recherches().map((u) => u.searchParams.get('department')))], ['41']);
    assert.equal(listings.length, 12);
  });

  test('Corse (2A/2B) : interrogée via l\'entrée « 20 - Corse » du site', async () => {
    assert.equal(SC_DEPARTEMENTS['20']?.id, 33, 'le site propose bien la Corse');
    const config = configSC({ zone: { mode: 'departements', departements: ['2A'] }, sc: { fiches_details: false } });
    const { http, logs } = await lancer({ config, http: fauxHttp({ recherche: () => PAGE_VIDE }) });
    assert.ok(!logs.some((m) => m.includes('inconnu')), logs.join('\n'));
    assert.ok(http.recherches().some((u) => u.searchParams.get('department') === '33'), 'recherche department=33 attendue');
  });

  test('erreur réseau sur une recherche : comptée et journalisée, sans exception', async () => {
    const http = fauxHttp({ recherche: () => { throw new Error('ECONNRESET'); } });
    const { listings, stats, logs } = await lancer({ http });
    assert.equal(listings.length, 0);
    assert.equal(stats.erreurs, 2);
    assert.equal(stats.pages, 0);
    assert.ok(logs.some((m) => m.includes('ECONNRESET')));
  });
});

describe('fetchSecondeChance : fiches détaillées', () => {
  // Avec age_max_mois = 2, seuls les chatons affichés « 2 mois » sont des chatons potentiels (âge < 2 + 1).
  const DEUX_MOIS = CARTES.filter((c) => c.age_mois === 2);

  test('premier lancement : fiches lues seulement pour les chatons potentiels', async () => {
    assert.equal(DEUX_MOIS.length, 5);
    const { listings, stats, http, state } = await lancer({ config: configSC({ age_max_mois: 2 }), context: { firstRun: true } });
    assert.deepEqual(http.fiches().sort(), DEUX_MOIS.map((c) => c.url).sort());
    assert.equal(stats.fiches, 5);
    assert.equal(stats.fiches_cache, 0);
    const lues = listings.filter((l) => l.fiche_lue).map((l) => l.source_id).sort();
    assert.deepEqual(lues, DEUX_MOIS.map((c) => c.id).sort());
    // Fiches mises en cache, horodatées avec « maintenant ».
    assert.equal(Object.keys(state.fiches).length, 5);
    assert.equal(state.fiches[`secondechance:${DEUX_MOIS[0].id}`].mise_en_cache, NOW.toISOString());
    assert.equal(state.fiches[`secondechance:${DEUX_MOIS[0].id}`].date_naissance, '2026-03-01');
    // Fiche appliquée : département d'adoption conservé, association renseignée, tableau des départements.
    const kawa = listings.find((l) => l.source_id === '1519197');
    assert.equal(kawa.lieu.departement, '75');
    assert.equal(kawa.lieu.departement_association, '95');
    assert.deepEqual(kawa.lieu.departements_adoption, ['75']);
    assert.equal(kawa.date_publication, '2026-09-24');
  });

  test('lancement suivant : fiches aussi pour les jamais vues, pas pour les déjà vues trop âgées', async () => {
    const { stats, http } = await lancer({ config: configSC({ age_max_mois: 2 }), context: { firstRun: false } });
    assert.equal(http.fiches().length, 12);
    assert.equal(stats.fiches, 12);
    const { http: http2 } = await lancer({ config: configSC({ age_max_mois: 2 }), state: etatAvecVus(IDS), context: { firstRun: false } });
    assert.deepEqual(http2.fiches().sort(), DEUX_MOIS.map((c) => c.url).sort());
  });

  test('fiche en cache : aucune requête, mais appliquée à l\'annonce', async () => {
    const state = emptyState();
    state.fiches['secondechance:1519197'] = { ...parseFichePage(FICHE), date_naissance: '2026-07-10', mise_en_cache: '2026-09-20T06:00:00.000Z' };
    const { listings, stats, http } = await lancer({ state, context: { firstRun: true } });
    assert.ok(!http.fiches().includes(carte('Kawa').url));
    assert.equal(http.fiches().length, 11);
    assert.equal(stats.fiches_cache, 1);
    assert.equal(stats.fiches, 11);
    const kawa = listings.find((l) => l.source_id === '1519197');
    assert.equal(kawa.fiche_lue, true);
    assert.equal(kawa.date_naissance, '2026-07-10');
    presque(kawa.age_mois, mois((NOW.getTime() - Date.UTC(2026, 6, 10)) / JOUR_MS));
    assert.equal(state.fiches['secondechance:1519197'].mise_en_cache, '2026-09-20T06:00:00.000Z', 'cache non réécrit');
  });

  test('fiches_details: false → aucune fiche lue', async () => {
    const { listings, http, stats } = await lancer({ config: configSC({ sc: { fiches_details: false } }) });
    assert.equal(http.fiches().length, 0);
    assert.equal(stats.fiches, 0);
    assert.ok(listings.every((l) => l.fiche_lue === false));
  });

  test('fiche illisible : erreur comptée, annonce conservée sans fiche', async () => {
    const http = fauxHttp({ fiche: () => { throw new Error('HTTP 500'); } });
    const { listings, stats, logs } = await lancer({ http, context: { firstRun: true } });
    assert.equal(listings.length, 12);
    assert.equal(stats.erreurs, 12);
    assert.equal(stats.fiches, 0);
    assert.ok(listings.every((l) => l.fiche_lue === false));
    assert.ok(logs.some((m) => m.includes('illisible') && m.includes('HTTP 500')));
  });
});

describe('faux positif Gilmore (fiche réelle : « 0 mois » affiché, « 6 ANS » dans la description)', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('./fixtures/secondechance_fiche_gilmore.html', import.meta.url), 'utf8');
  test('parseFichePage : âge « 0 mois », pas de date de naissance, description complète conservée', () => {
    const f = parseFichePage(html);
    assert.equal(f.age_texte, '0 mois');
    assert.equal(f.date_naissance, null);
    assert.match(f.description_complete, /GILMORE 6 ANS/);
    assert.equal(f.association.departement, '94');
  });
  test('applyFiche : 6 ans d\'après la description, donc pas un chaton', () => {
    const carte = { id: '1516867', url: 'https://www.secondechance.org/animal/chat-sacre-de-birmanie-gilmore-1516867', slug: 'chat-sacre-de-birmanie-gilmore-1516867', nom: 'Gilmore', association: 'Les petits protégés de Jo & Co', departement: '75', race: 'SACRE DE BIRMANIE', sexe: 'male', age_texte: '0 mois', age_mois: null, image: null, espece: 'chat' };
    const l = applyFiche(mapCard(carte, '75'), parseFichePage(html), new Date(Date.UTC(2026, 8, 24)));
    assert.equal(l.age_source, 'description');
    assert.ok(l.age_mois >= 72, String(l.age_mois));
    assert.equal(l.age_mois < 4, false);
  });
  test('parseSearchPage : une carte « 0 mois » donne age_mois = null (âge non renseigné)', () => {
    const html2 = '<p>1 résultats trouvés</p><a href="https://www.secondechance.org/animal/chat-europeen-x-1"><h3>X</h3><h4>Asso (75)</h4><p class="open-sans text-sm text-gray-dark-sc">EUROPÉEN Mâle - 0 mois</p></a>';
    const { cards } = parseSearchPage(html2);
    assert.equal(cards[0].age_texte, '0 mois');
    assert.equal(cards[0].age_mois, null);
  });
});
