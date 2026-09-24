// Tests unitaires de src/age.js (âges, dates de naissance) et src/text.js (utilitaires texte / HTML).
// Aucun accès réseau ; toutes les dates sont construites en UTC et « maintenant » est figé.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bestAgeInMonths,
  formatAge,
  monthsBetween,
  parseAgeToMonths,
  parseBirthDate,
  toIsoDate,
} from '../src/age.js';
import { decodeEntities, normalize, normalizeSex, stripTags, truncate } from '../src/text.js';

const JOURS_PAR_MOIS = 365.25 / 12; // même convention que src/age.js
const JOUR_MS = 86_400_000;

/** Date UTC à minuit (mois 1–12). */
const utc = (annee, mois, jour) => new Date(Date.UTC(annee, mois - 1, jour));

/** « Aujourd'hui » figé pour tous les tests dépendant du temps (date de la fixture Seconde Chance). */
const MAINTENANT = utc(2026, 9, 24);

function assertProche(reel, attendu, epsilon = 1e-9) {
  assert.ok(Math.abs(reel - attendu) < epsilon, `${reel} devrait valoir ≈ ${attendu}`);
}

// ---------------------------------------------------------------------------
// src/age.js
// ---------------------------------------------------------------------------

describe('parseAgeToMonths', () => {
  test('lit un nombre de mois, sans tenir compte de la casse', () => {
    assert.equal(parseAgeToMonths('3 mois'), 3);
    assert.equal(parseAgeToMonths('3 Mois'), 3);
    assert.equal(parseAgeToMonths('  10 mois  '), 10);
  });

  test('convertit les années et additionne les mois ("1 an" → 12, "2 ans" → 24, "2 ans 3 mois" → 27)', () => {
    assert.equal(parseAgeToMonths('1 an'), 12);
    assert.equal(parseAgeToMonths('1 AN'), 12);
    assert.equal(parseAgeToMonths('2 ans'), 24);
    assert.equal(parseAgeToMonths('12 années'), 144);
    assert.equal(parseAgeToMonths('2 ans 3 mois'), 27);
    assert.equal(parseAgeToMonths('1 an 1 mois'), 13);
  });

  test('convertit les semaines et les jours en mois décimaux', () => {
    assertProche(parseAgeToMonths('6 semaines'), (6 * 7) / JOURS_PAR_MOIS); // ≈ 1,38
    assertProche(parseAgeToMonths('1 semaine'), 7 / JOURS_PAR_MOIS);
    assertProche(parseAgeToMonths('6 sem.'), (6 * 7) / JOURS_PAR_MOIS);
    assertProche(parseAgeToMonths('8 jours'), 8 / JOURS_PAR_MOIS);
  });

  test('ajoute un demi-mois pour "… mois et demi" et accepte la virgule décimale', () => {
    assert.equal(parseAgeToMonths('3 mois et demi'), 3.5);
    assert.equal(parseAgeToMonths('10 mois et demi'), 10.5);
    assert.equal(parseAgeToMonths('2,5 mois'), 2.5);
  });

  test("extrait l'âge d'un libellé de carte Seconde Chance (\"EUROPÉEN Mâle - 2 mois\")", () => {
    assert.equal(parseAgeToMonths('EUROPÉEN Mâle - 2 mois'), 2);
    assert.equal(parseAgeToMonths('EUROPÉEN Femelle - 4 mois'), 4);
  });

  test('retourne null quand l\'âge est absent ou inconnu ("N/A", null, vide, "inconnu", texte sans nombre)', () => {
    for (const valeur of ['N/A', 'n/a', 'NA', null, undefined, '', '   ', 'inconnu', '-', 'Ras', 'quelques mois']) {
      assert.equal(parseAgeToMonths(valeur), null, `valeur ${JSON.stringify(valeur)}`);
    }
  });
});

describe('parseBirthDate', () => {
  test('lit le format de la SPA "Né(e) le 2026-07-01" en date UTC à minuit', () => {
    const d = parseBirthDate('Né(e) le 2026-07-01');
    assert.ok(d instanceof Date);
    assert.equal(d.getTime(), Date.UTC(2026, 6, 1));
    assert.equal(parseBirthDate('2019-03-14').getTime(), Date.UTC(2019, 2, 14));
  });

  test('lit le format français jj/mm/aaaa (01/03/2026 = 1er mars, pas 3 janvier)', () => {
    assert.equal(parseBirthDate('01/03/2026').getTime(), Date.UTC(2026, 2, 1));
    assert.equal(parseBirthDate('Date de naissance : 01/03/2026').getTime(), Date.UTC(2026, 2, 1));
  });

  test('rejette les dates impossibles (31/02, 29/02 hors année bissextile, mois 13, jour 00)', () => {
    assert.equal(parseBirthDate('31/02/2026'), null);
    assert.equal(parseBirthDate('29/02/2025'), null);
    assert.equal(parseBirthDate('2026-02-30'), null);
    assert.equal(parseBirthDate('2026-13-01'), null);
    assert.equal(parseBirthDate('00/01/2026'), null);
    // … mais accepte un vrai 29 février.
    assert.equal(parseBirthDate('29/02/2024').getTime(), Date.UTC(2024, 1, 29));
  });

  test('retourne null sans date exploitable (null, texte libre, format incomplet, année hors bornes)', () => {
    for (const valeur of [null, undefined, '', 'inconnue', '1/3/2026', '01/03/1989', '2101-01-01']) {
      assert.equal(parseBirthDate(valeur), null, `valeur ${JSON.stringify(valeur)}`);
    }
  });
});

describe('monthsBetween', () => {
  test('compte en mois moyens de 365,25 / 12 jours', () => {
    // 2026-07-01 → 2026-09-24 : 85 jours.
    assertProche(monthsBetween(utc(2026, 7, 1), MAINTENANT), 85 / JOURS_PAR_MOIS);
    assertProche(monthsBetween(MAINTENANT, MAINTENANT), 0);
    // Sur 4 années (dont une bissextile), le compte tombe juste : 48 mois.
    assertProche(monthsBetween(utc(2022, 9, 24), MAINTENANT), 48);
    // Naissance postérieure à « maintenant » → valeur négative (bestAgeInMonths la ramène à 0).
    assert.ok(monthsBetween(utc(2026, 10, 24), MAINTENANT) < 0);
  });

  test('utilise la date courante par défaut', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: MAINTENANT.getTime() });
    assertProche(monthsBetween(new Date(MAINTENANT.getTime() - 61 * JOUR_MS)), 61 / JOURS_PAR_MOIS);
  });

  test(
    'le jour anniversaire, l\'âge affiché correspond aux mois calendaires écoulés',
    { todo: 'bug: mois moyen de 30,44 j → né le 24/01, affiché « 1 mois » le 24/03 ; « 11 mois » le jour de ses 1 an' },
    () => {
      assert.equal(formatAge(monthsBetween(utc(2026, 1, 24), utc(2026, 3, 24))), '2 mois');
      assert.equal(formatAge(monthsBetween(utc(2025, 9, 24), MAINTENANT)), '1 an');
      assert.equal(formatAge(monthsBetween(utc(2024, 9, 24), MAINTENANT)), '2 ans');
    },
  );
});

describe('bestAgeInMonths', () => {
  test('privilégie la date de naissance sur le texte d\'âge', () => {
    const age = bestAgeInMonths({ birthDate: utc(2026, 7, 1), ageText: '1 an' }, MAINTENANT);
    assertProche(age, 85 / JOURS_PAR_MOIS);
  });

  test('se rabat sur le texte d\'âge sans date de naissance valide (null si aucun des deux)', () => {
    assert.equal(bestAgeInMonths({ ageText: '3 mois' }, MAINTENANT), 3);
    assert.equal(bestAgeInMonths({ birthDate: null, ageText: '2 ans' }, MAINTENANT), 24);
    assert.equal(bestAgeInMonths({ birthDate: new Date('pas une date'), ageText: '3 mois' }, MAINTENANT), 3);
    // Une chaîne n'est pas une Date : elle est ignorée.
    assert.equal(bestAgeInMonths({ birthDate: '2026-07-01', ageText: '5 mois' }, MAINTENANT), 5);
    // Ni date ni texte exploitable → null.
    assert.equal(bestAgeInMonths({}, MAINTENANT), null);
    assert.equal(bestAgeInMonths({ ageText: 'N/A' }, MAINTENANT), null);
  });

  test('ramène à 0 une date de naissance dans le futur', () => {
    assert.equal(bestAgeInMonths({ birthDate: utc(2026, 10, 1), ageText: '3 mois' }, MAINTENANT), 0);
  });

  test('cas réel : Sweety, née le 01/03/2026, a environ 6,8 mois le 24/09/2026 (« 6 mois »)', () => {
    const naissance = parseBirthDate('Date de naissance : 01/03/2026');
    const age = bestAgeInMonths({ birthDate: naissance, ageText: '6 mois' }, MAINTENANT);
    assertProche(age, 207 / JOURS_PAR_MOIS); // 207 jours
    assert.equal(formatAge(age, { precis: true }), '6 mois');
  });
});

describe('formatAge', () => {
  test('affiche les mois entiers (tronqués) sous un an', () => {
    assert.equal(formatAge(1), '1 mois');
    assert.equal(formatAge(3), '3 mois');
    assert.equal(formatAge(3.9), '3 mois');
    assert.equal(formatAge(11.99), '11 mois');
    // « précis » ne change rien au-delà d'un mois.
    assert.equal(formatAge(2.5, { precis: true }), '2 mois');
  });

  test('affiche les années, avec le reste en mois ("1 an", "2 ans", "2 ans 3 mois")', () => {
    assert.equal(formatAge(12), '1 an');
    assert.equal(formatAge(13), '1 an 1 mois');
    assert.equal(formatAge(24), '2 ans');
    assert.equal(formatAge(27), '2 ans 3 mois');
    assert.equal(formatAge(27.8), '2 ans 3 mois');
  });

  test('âge non précis de moins d\'un mois → « moins d\'un mois »', () => {
    assert.equal(formatAge(0.5), "moins d'un mois");
    assert.equal(formatAge(0.5, { precis: false }), "moins d'un mois");
    assert.equal(formatAge(parseAgeToMonths('3 semaines')), "moins d'un mois");
  });

  test('âge précis de moins d\'un mois → en semaines (au moins 1, singulier / pluriel)', () => {
    assert.equal(formatAge(0, { precis: true }), '1 semaine');
    assert.equal(formatAge(7 / JOURS_PAR_MOIS, { precis: true }), '1 semaine');
    assert.equal(formatAge(0.5, { precis: true }), '2 semaines'); // ≈ 15 jours
    assert.equal(formatAge(0.99, { precis: true }), '4 semaines');
  });

  test('retourne « âge inconnu » pour null, undefined ou NaN', () => {
    assert.equal(formatAge(null), 'âge inconnu');
    assert.equal(formatAge(undefined), 'âge inconnu');
    assert.equal(formatAge(Number.NaN, { precis: true }), 'âge inconnu');
  });
});

describe('toIsoDate', () => {
  test('formate une Date en AAAA-MM-JJ (UTC)', () => {
    assert.equal(toIsoDate(utc(2026, 3, 1)), '2026-03-01');
    assert.equal(toIsoDate(new Date('2026-07-01T23:59:59Z')), '2026-07-01');
    assert.equal(toIsoDate(parseBirthDate('Né(e) le 2026-07-01')), '2026-07-01');
  });

  test('retourne null pour une date invalide ou une valeur qui n\'est pas une Date', () => {
    assert.equal(toIsoDate(new Date('pas une date')), null);
    assert.equal(toIsoDate(null), null);
    assert.equal(toIsoDate(undefined), null);
    assert.equal(toIsoDate('2026-03-01'), null);
    assert.equal(toIsoDate(Date.UTC(2026, 2, 1)), null);
    assert.equal(toIsoDate(parseBirthDate('31/02/2026')), null);
  });
});

// ---------------------------------------------------------------------------
// src/text.js
// ---------------------------------------------------------------------------

describe('decodeEntities', () => {
  test('décode les entités nommées usuelles', () => {
    assert.equal(decodeEntities('Chat &amp; chien'), 'Chat & chien');
    assert.equal(decodeEntities('&eacute;t&eacute; &agrave; l&rsquo;&oelig;il'), 'été à l’œil');
    assert.equal(decodeEntities('&lt;b&gt; &quot;x&quot; 10&nbsp;&euro;'), '<b> "x" 10 €');
  });

  test('décode les entités décimales, y compris avec zéros initiaux (&#039;)', () => {
    assert.equal(decodeEntities('l&#039;adoption'), "l'adoption");
    assert.equal(decodeEntities('&#233;&#8364;'), 'é€');
  });

  test('décode les entités hexadécimales, x minuscule ou majuscule', () => {
    assert.equal(decodeEntities('&#x00C9;levage'), 'Élevage');
    assert.equal(decodeEntities('&#X27;&#xe9;'), "'é");
  });

  test('ne décode qu\'une fois, laisse intacts entités inconnues et & isolés ; null → ""', () => {
    assert.equal(decodeEntities('&amp;#39;'), '&#39;');
    assert.equal(decodeEntities('&amp;eacute;'), '&eacute;');
    assert.equal(decodeEntities('&#38;#39;'), '&#39;');
    assert.equal(decodeEntities('&inconnue; AT&T & co'), '&inconnue; AT&T & co');
    assert.equal(decodeEntities(null), '');
    assert.equal(decodeEntities(undefined), '');
  });

  test(
    'ne lève pas d\'exception sur une référence numérique hors Unicode',
    () => {
      for (const entite of ['&#x110000;', '&#99999999;']) {
        let resultat;
        assert.doesNotThrow(() => { resultat = decodeEntities(`a${entite}b`); }, entite);
        assert.ok(resultat.startsWith('a') && resultat.endsWith('b'), entite);
      }
    },
  );
});

describe('stripTags', () => {
  test('supprime les balises et convertit <br> et fins de bloc en sauts de ligne', () => {
    assert.equal(stripTags('<p>Bonjour</p><p>Monde</p>'), 'Bonjour\nMonde');
    assert.equal(stripTags('a<br>b<br/>c<BR />d'), 'a\nb\nc\nd');
    assert.equal(stripTags('<ul><li>un</li><li>deux</li></ul>'), 'un\ndeux');
  });

  test('supprime entièrement le contenu des <script>, <style> et <svg>', () => {
    assert.equal(stripTags('<script>alert(1)</script>ok'), 'ok');
    assert.equal(stripTags('<SCRIPT type="x">mal()</SCRIPT>fin'), 'fin');
    assert.equal(stripTags('<style>.a{color:red}</style>ok'), 'ok');
    assert.equal(stripTags('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>ok'), 'ok');
  });

  test('décode les entités après avoir retiré les balises (&lt;b&gt; reste du texte)', () => {
    assert.equal(stripTags('<p>&lt;b&gt; n&#039;est pas une balise</p>'), "<b> n'est pas une balise");
    assert.equal(stripTags('<b>Chat</b>&nbsp;&nbsp;câlin'), 'Chat câlin');
  });

  test('normalise les espaces, fusionne les lignes vides ; null → ""', () => {
    assert.equal(stripTags('  <div> a \t  b  </div>\n\n\n<div>c</div> '), 'a b\nc');
    assert.equal(stripTags('<p>a</p>\r\n\r\n<p>b</p>'), 'a\nb');
    assert.equal(stripTags(null), '');
    assert.equal(stripTags(undefined), '');
  });
});

describe('truncate', () => {
  test('tronque au-delà de max caractères, « … » compris, sans espace avant ; sinon texte « trimé »', () => {
    assert.equal(truncate('abcd', 4), 'abcd');
    assert.equal(truncate('  abc  ', 3), 'abc');
    assert.equal(truncate('court'), 'court');
    assert.equal(truncate('abcdef', 4), 'abc…');
    assert.equal(truncate('abc def ghi', 5), 'abc…');
    assert.ok(truncate('abc def ghi', 5).length <= 5);
  });

  test('utilise 280 caractères par défaut ; null → ""', () => {
    const long = 'x'.repeat(300);
    const r = truncate(long);
    assert.equal(r.length, 280);
    assert.ok(r.endsWith('…'));
    assert.equal(truncate(null), '');
    assert.equal(truncate(undefined, 10), '');
  });

  test(
    'ne coupe pas un emoji (paire de substitution) en deux',
    () => {
      const r = truncate('ab😺cd', 4);
      assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(r), `substitut isolé dans ${JSON.stringify(r)}`);
      assert.ok(r.endsWith('…'));
    },
  );
});

describe('normalize', () => {
  test('met en minuscules, retire accents et espaces autour ; accepte null et nombres', () => {
    assert.equal(normalize('  Élève  '), 'eleve');
    assert.equal(normalize('ÇA'), 'ca');
    assert.equal(normalize('Mâle'), 'male');
    assert.equal(normalize('Val-d\'Oise'), "val-d'oise");
    // null, undefined et nombres acceptés.
    assert.equal(normalize(null), '');
    assert.equal(normalize(undefined), '');
    assert.equal(normalize(95), '95');
  });
});

describe('normalizeSex', () => {
  test('reconnaît les libellés des deux sites (male/female, Mâle/Femelle, M/F), sinon null', () => {
    for (const v of ['male', 'Mâle', '  MÂLE ', 'M']) assert.equal(normalizeSex(v), 'male', v);
    for (const v of ['female', 'Femelle', 'FEMELLE', 'f']) assert.equal(normalizeSex(v), 'femelle', v);
    // Absent ou non reconnu → null.
    for (const v of [null, undefined, '', '   ', 'inconnu', 'Non précisé']) {
      assert.equal(normalizeSex(v), null, JSON.stringify(v));
    }
  });
});
