// Âge déduit d'une description libre : formulations réelles rencontrées sur la-spa.fr et secondechance.org,
// et pièges connus (durées, événements passés, conditions d'adoption) qui ne doivent PAS donner d'âge.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ageFromDescription, resolveAge } from '../src/age.js';

const MAINTENANT = new Date(Date.UTC(2026, 8, 24, 12)); // 24/09/2026
const proche = (a, b, eps = 0.06) => Math.abs(a - b) <= eps;

/** [texte, mois attendus (null = aucun âge), fiabilité attendue] */
const CAS_POSITIFS = [
  ['Aujourd\'hui on vous présente également GILMORE 6 ANS TYPÉ SACRÉ DE BIRMANIE POILS MI LONGS', 72, 'forte'],
  ['CHOUQUETTE – FEMELLE – 2 MOIS Chouquette est un chaton adorable', 2, 'forte'],
  ['[Adoption] Gigi et Rosso, 10 mois C’est au tour du petit Gigi de se présenter', 10, 'forte'],
  ['[Adoption] Chantilly, 4 mois Chantilly, 4 mois, est un adorable chaton', 4, 'forte'],
  ['Mia est une chatonne âgée de 3 mois et demi, née chez une famille d’accueil.', 3.5, 'forte'],
  ['Onyx 🎈 Âgés de 2 mois et demi. 🖤 Onyx – Mâle, gris & blanc', 2.5, 'forte'],
  ['Belly et Bimbo, deux femelles âgées d\'environ 3 mois. Nées d\'une chatte errante à Bruges.', 3, 'forte'],
  ['Zelda est âgé de 1 an et 10 mois. Arrivé au refuge il y a 2 mois.', 22, 'forte'],
  ['Il a 2 ans, stérilisé à 6 mois, vacciné depuis 1 an.', 24, 'forte'],
  ['Elle a 2 ans et demi et adore les câlins.', 30, 'forte'],
  ['Nito est un chaton de 2 mois et demi qui est un peu timide au début.', 2.5, 'forte'],
  ['Manao, adorable chaton de 2 mois 1/2 retrouvé avec sa fratrie dans un jardin', 2, 'forte'],
  ['Chaton de 2 mois, sa maman de 3 ans reste au refuge.', 2, 'forte'],
  ['Nougat mâle 3mois et demi Joueur Câlin Curieux', 3, 'forte'],
  ['Royal est un minou de 1 ans, c\'est un gentil chat.', 12, 'forte'],
  ['Petit mâle roux de 3 mois, est une véritable douceur sur quatre pattes.', 3, 'faible'],
  ['Deux petits chatons de 4 mois arrivés de Martinique. Encore un peu craintifs.', 4, 'forte'],
  ['Simba, petit chaton d’environ 2 mois, sera disponible à l’adoption dans quelques jours.', 2, 'forte'],
  ['Biscuit (mâle, 5 mois) cherche une famille.', 5, 'forte'],
  ['Caramel a 6 semaines et découvre le monde.', 6 * 7 / (365.25 / 12), 'forte'],
  ['Elle n\'a que 3 mois mais déjà beaucoup de caractère.', 3, 'forte'],
  ['𝗗𝗮𝘁𝗲 𝗱𝗲 𝗻𝗮𝗶𝘀𝘀𝗮𝗻𝗰𝗲 : 3 mois 𝗦𝗲𝘅𝗲 : 2 mâles', 3, 'forte'],
];

const CAS_NEGATIFS = [
  'Sweety est un jeune chat très sociable, aussi bien avec les humains qu’avec ses congénères.',
  'Le certificat d’engagement daté et signé de 7 jours est obligatoire.',
  'Sans réponse de notre part dans les 3 semaines, veuillez considérer que votre demande n\'a pas été retenue.',
  'Il sera stérilisé lorsqu\'il aura 6 mois, visible sur Roubaix.',
  'Test FIV à refaire à ses 6 mois pour en être bien sûr.',
  'Quand il avait environ 1 mois, il a été gardé pour le sociabiliser.',
  'Alors âgé de seulement 1 an, TITOU a ensuite enchaîné les refuges.',
  'Il est arrivé au refuge il y a 3 mois et attend depuis 2 ans.',
  'Adoptable sous contrat de 2 mois d’essai. Il est doux.',
  'Vaccins à renouveler tous les ans, vermifuge tous les 3 mois.',
  'Trouvée à 2 semaines dans un carton, elle a été biberonnée.',
  'Stérilisée à 6 mois, pucée et vaccinée.',
  'Pas d’âge ici, juste un texte : 3 chats vivent ensemble.',
  '',
  null,
];

describe('ageFromDescription — formulations réelles', () => {
  for (const [texte, mois, fiab] of CAS_POSITIFS) {
    test(`« ${texte.slice(0, 60)} » → ${mois} mois (${fiab})`, () => {
      const r = ageFromDescription(texte, MAINTENANT);
      assert.ok(r, 'aucun âge trouvé');
      assert.ok(proche(r.mois, mois), `attendu ${mois}, obtenu ${r.mois} (« ${r.extrait} »)`);
      assert.equal(r.fiabilite, fiab);
    });
  }
});

describe('ageFromDescription — pièges (aucun âge)', () => {
  for (const texte of CAS_NEGATIFS) {
    test(`« ${String(texte).slice(0, 60)} » → null`, () => {
      const r = ageFromDescription(texte, MAINTENANT);
      assert.equal(r, null, r ? `âge parasite ${r.mois} mois « ${r.extrait} »` : '');
    });
  }
});

describe('ageFromDescription — dates de naissance', () => {
  test('« nés le 12 juin » sans année : l\'année en cours si la date est passée', () => {
    const r = ageFromDescription('Nés le 12 juin, ces 4 chatons cherchent une famille.', MAINTENANT);
    assert.equal(r.date_naissance, '2026-06-12');
    assert.equal(r.fiabilite, 'forte');
    assert.ok(proche(r.mois, 104 / (365.25 / 12), 0.03));
  });
  test('« née le 20 décembre » sans année : l\'année précédente si la date est future', () => {
    const r = ageFromDescription('Née le 20 décembre, Plume a grandi en famille.', MAINTENANT);
    assert.equal(r.date_naissance, '2025-12-20');
  });
  test('« née le 01/03/2026 » et « né en mars 2026 » (milieu de mois)', () => {
    assert.equal(ageFromDescription('Née le 01/03/2026, Bulle est une petite européenne.', MAINTENANT).date_naissance, '2026-03-01');
    assert.equal(ageFromDescription('Né en mars 2026 dans une grange.', MAINTENANT).date_naissance, '2026-03-15');
  });
  test('date de naissance future ou absurde ignorée (repli sur les autres formulations)', () => {
    assert.equal(ageFromDescription('Né le 12/12/2027.', MAINTENANT), null);
    assert.equal(ageFromDescription('Né le 01/01/1980, il a 3 ans.', MAINTENANT).mois, 36);
  });
});

describe('resolveAge — combinaison des sources', () => {
  test('la date de naissance l\'emporte sur tout', () => {
    const r = resolveAge({ birthDate: new Date(Date.UTC(2026, 6, 1)), ageText: '5 ans', description: 'Il a 6 ans.', now: MAINTENANT });
    assert.equal(r.age_source, 'naissance');
    assert.equal(r.date_naissance, '2026-07-01');
    assert.ok(r.age_mois < 3);
  });
  test('« 0 mois » (non renseigné) + description « 6 ANS » → 72 mois d\'après la description (cas Gilmore)', () => {
    const r = resolveAge({ ageText: '0 mois', description: 'On vous présente GILMORE 6 ANS TYPÉ SACRÉ DE BIRMANIE', now: MAINTENANT });
    assert.equal(r.age_source, 'description');
    assert.ok(r.age_mois >= 72);
    assert.equal(r.age_conflit, null);
  });
  test('« 0 mois » sans âge dans la description → âge inconnu (jamais un chaton par défaut)', () => {
    const r = resolveAge({ ageText: '0 mois', description: 'Bruneau est une petite minette qui nous arrive de la fourrière.', now: MAINTENANT });
    assert.equal(r.age_mois, null);
    assert.equal(r.age_source, null);
  });
  test('âge structuré connu : conservé même si la description (plus ancienne) dit moins', () => {
    const r = resolveAge({ ageText: '5 mois', description: 'Adorable chaton de 2 mois et demi, prêt à trouver sa famille.', now: MAINTENANT });
    assert.equal(r.age_mois, 5);
    assert.equal(r.age_source, 'fiche');
  });
  test('contradiction forte : carte « 2 mois » mais description « il a 6 ans » → la description l\'emporte et le conflit est signalé', () => {
    const r = resolveAge({ ageText: '2 mois', description: 'Il a 6 ans et adore les câlins.', now: MAINTENANT });
    assert.equal(r.age_source, 'description');
    assert.ok(r.age_mois >= 72);
    assert.match(r.age_conflit, /2 mois/);
  });
  test('mention faible d\'un adulte (« sa maman de 3 ans ») ne renverse pas un âge structuré de chaton', () => {
    const r = resolveAge({ ageText: '2 mois', description: 'Sa maman de 3 ans reste au refuge.', now: MAINTENANT });
    assert.equal(r.age_mois, 2);
    assert.equal(r.age_source, 'fiche');
  });
  test('vieillissement : « chaton de 2 mois et demi » publié le 01/08 vaut ≈ 4,3 mois le 24/09', () => {
    const r = resolveAge({ ageText: null, description: 'Nito est un chaton de 2 mois et demi.', asOf: '2026-08-01', now: MAINTENANT });
    assert.ok(r.age_mois > 4.2 && r.age_mois < 4.4, String(r.age_mois));
    assert.equal(r.age_source, 'description');
  });
  test('vieillissement non appliqué quand la description donne une date de naissance', () => {
    const r = resolveAge({ description: 'Née le 01/03/2026.', asOf: '2026-08-01', now: MAINTENANT });
    assert.equal(r.date_naissance, '2026-03-01');
    assert.ok(r.age_mois < 7);
  });
  test('date de naissance dans la description qui contredit fortement la fiche → conflit signalé', () => {
    const r = resolveAge({ ageText: '5 ans', description: 'Née le 01/03/2026.', now: MAINTENANT });
    assert.equal(r.age_source, 'description');
    assert.match(r.age_conflit, /5 ans/);
  });
  test('rien de connu → null partout', () => {
    assert.deepEqual(resolveAge({ now: MAINTENANT }), { age_mois: null, age_source: null, age_conflit: null, date_naissance: null });
  });
});
