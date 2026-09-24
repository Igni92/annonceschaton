// Tests de src/config.js : fusion, valeurs par défaut, variables d'environnement, validation et chargement.
// Aucun accès réseau ; les fichiers de configuration sont écrits dans un dossier temporaire (os.tmpdir()).
// Ce module ne dépend pas de l'heure courante : aucun « now » à fixer.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CONFIG, ENV_OVERRIDES, applyEnv, deepMerge, loadConfig, validateConfig } from '../src/config.js';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Copie modifiable de la configuration par défaut, éventuellement surchargée. */
const config = (override = {}) => deepMerge(DEFAULT_CONFIG, override);

/** validateConfig doit lever une Error « Configuration invalide » dont le message contient `motif`. */
function assertInvalide(cfg, motif) {
  assert.throws(
    () => validateConfig(cfg),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /^Configuration invalide :/);
      assert.match(err.message, motif);
      return true;
    },
  );
}

let dossier;
/** Écrit `contenu` (objet → JSON, chaîne → tel quel) dans le dossier temporaire et renvoie le chemin absolu. */
function ecrireConfig(nom, contenu) {
  const fichier = path.join(dossier, nom);
  writeFileSync(fichier, typeof contenu === 'string' ? contenu : JSON.stringify(contenu, null, 2));
  return fichier;
}

before(() => {
  dossier = mkdtempSync(path.join(os.tmpdir(), 'annonceschaton-config-'));
});
after(() => {
  rmSync(dossier, { recursive: true, force: true });
});

describe('deepMerge', () => {
  test('fusionne récursivement les objets et conserve les clés non surchargées', () => {
    const base = { zone: { mode: 'rayon', rayon_km: 50, centre: { ville: 'Paris', code_postal: '75011' } }, age_max_mois: 4 };
    const out = deepMerge(base, { zone: { rayon_km: 20, centre: { ville: 'Lyon' } } });
    assert.deepEqual(out, { zone: { mode: 'rayon', rayon_km: 20, centre: { ville: 'Lyon', code_postal: '75011' } }, age_max_mois: 4 });
  });

  test('ignore les clés "//" (commentaires JSON) à tous les niveaux', () => {
    const out = deepMerge({ zone: { mode: 'rayon' } }, { '//': 'racine', zone: { '//': 'imbriqué', mode: 'france' } });
    assert.deepEqual(out, { zone: { mode: 'france' } });
    assert.equal(Object.hasOwn(out, '//'), false);
    assert.equal(Object.hasOwn(out.zone, '//'), false);
  });

  test('remplace les tableaux au lieu de les fusionner ou de les concaténer', () => {
    const out = deepMerge({ zone: { departements: ['75', '92', '93', '94'] } }, { zone: { departements: ['69'] } });
    assert.deepEqual(out.zone.departements, ['69']);
    assert.deepEqual(deepMerge({ l: [1, 2, 3] }, { l: [] }).l, []);
  });

  test('remplace scalaires et objets (null, nombre ↔ objet) ; surcharge undefined → copie de la base', () => {
    const out = deepMerge({ a: 1, b: { c: 2 }, d: 'x' }, { a: null, b: 3, d: { e: 4 } });
    assert.deepEqual(out, { a: null, b: 3, d: { e: 4 } });
    // Au premier niveau : surcharge absente (undefined) → copie de la base ; surcharge non objet → copie de la surcharge.
    const base = { a: { b: 1 } };
    const copie = deepMerge(base, undefined);
    assert.deepEqual(copie, base);
    assert.notEqual(copie, base);
    assert.deepEqual(deepMerge(base, ['x']), ['x']);
    assert.equal(deepMerge(base, 7), 7);
  });

  test('ne modifie ni la base ni la surcharge, et le résultat ne partage aucune référence', () => {
    const base = { zone: { departements: ['75'], centre: { ville: 'Paris' } } };
    const surcharge = { zone: { centre: { code_postal: '75011' }, liste: ['a'] } };
    const out = deepMerge(base, surcharge);
    out.zone.departements.push('92');
    out.zone.centre.ville = 'Lyon';
    out.zone.liste.push('b');
    assert.deepEqual(base, { zone: { departements: ['75'], centre: { ville: 'Paris' } } });
    assert.deepEqual(surcharge, { zone: { centre: { code_postal: '75011' }, liste: ['a'] } });
  });
});

describe('DEFAULT_CONFIG', () => {
  test('est valide telle quelle', () => {
    const cfg = config();
    assert.equal(validateConfig(cfg), cfg);
  });

  test('reprend les valeurs par défaut documentées dans le README', () => {
    const c = DEFAULT_CONFIG;
    assert.equal(c.zone.mode, 'rayon');
    assert.deepEqual(c.zone.centre, { ville: 'Paris', code_postal: '75011', latitude: null, longitude: null });
    assert.equal(c.zone.rayon_km, 50);
    assert.deepEqual(c.zone.departements, ['75', '92', '93', '94']);
    assert.equal(c.age_max_mois, 4);
    assert.deepEqual(c.nouveaux_arrivants, { jours: 7, critere: 'les_deux', tous_ages: false });
    assert.equal(c.inclure_reserves, false);
    assert.equal(c.sources.laspa.actif, true);
    assert.deepEqual(c.sources.secondechance, { actif: true, adoptable_hors_departement: false, pages_max: 10, fiches_details: true });
    assert.equal(c.notifications.console, true);
    assert.deepEqual(c.notifications.fichier, { actif: true, dossier: 'reports' });
    assert.equal(c.notifications.discord.actif, false);
    assert.equal(c.notifications.telegram.actif, false);
    assert.deepEqual(c.planification, { heure: '08:00', fuseau: 'Europe/Paris' });
    assert.deepEqual(
      { timeout_ms: c.http.timeout_ms, tentatives: c.http.tentatives, concurrence: c.http.concurrence, delai_ms: c.http.delai_ms },
      { timeout_ms: 30_000, tentatives: 3, concurrence: 4, delai_ms: 250 },
    );
    assert.deepEqual(c.etat, { fichier: 'data/state.json', retention_jours: 90 });
    assert.ok(Object.isFrozen(c));
  });

  test('config.example.json fusionné aux défauts est valide et équivalent aux défauts (commentaires "//" ignorés)', () => {
    const exemple = JSON.parse(readFileSync(path.join(RACINE, 'config.example.json'), 'utf8'));
    const cfg = config(exemple);
    assert.deepEqual(cfg, config());
    validateConfig(cfg);
  });

  test('contient zone.marge_departement_km = 25 (valeur par défaut annoncée par le README)', () => {
    assert.equal(DEFAULT_CONFIG.zone.marge_departement_km, 25);
  });
});

describe('applyEnv', () => {
  test('DISCORD_WEBHOOK_URL renseigne l\'URL et active Discord', () => {
    const url = 'https://discord.com/api/webhooks/123/abc';
    const cfg = applyEnv(config(), { DISCORD_WEBHOOK_URL: url });
    assert.equal(cfg.notifications.discord.webhook_url, url);
    assert.equal(cfg.notifications.discord.actif, true);
    validateConfig(cfg);
  });

  test('Telegram n\'est activé que si TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_ID sont tous deux fournis', () => {
    const seulJeton = applyEnv(config(), { TELEGRAM_BOT_TOKEN: '123:abc' });
    assert.equal(seulJeton.notifications.telegram.bot_token, '123:abc');
    assert.equal(seulJeton.notifications.telegram.actif, false);
    const complet = applyEnv(config(), { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '-10042' });
    assert.equal(complet.notifications.telegram.actif, true);
    assert.equal(complet.notifications.telegram.chat_id, '-10042');
  });

  test('ANNONCES_DEPARTEMENTS "69, 01" → liste ["69", "01"] (virgules, espaces ou points-virgules)', () => {
    assert.deepEqual(applyEnv(config(), { ANNONCES_DEPARTEMENTS: '69, 01' }).zone.departements, ['69', '01']);
    assert.deepEqual(applyEnv(config(), { ANNONCES_DEPARTEMENTS: ' 75;92 93,,94 ' }).zone.departements, ['75', '92', '93', '94']);
  });

  test('ANNONCES_RAYON_KM "12,5" → 12.5 : virgule décimale acceptée, valeur illisible laissée à la validation', () => {
    const cfg = applyEnv(config(), {
      ANNONCES_RAYON_KM: '12,5',
      ANNONCES_LATITUDE: '45,764',
      ANNONCES_LONGITUDE: '4.836',
      ANNONCES_AGE_MAX_MOIS: '6',
      ANNONCES_NOUVEAUX_JOURS: '3',
    });
    assert.equal(cfg.zone.rayon_km, 12.5);
    assert.equal(cfg.zone.centre.latitude, 45.764);
    assert.equal(cfg.zone.centre.longitude, 4.836);
    assert.equal(cfg.age_max_mois, 6);
    assert.equal(cfg.nouveaux_arrivants.jours, 3);
    // Valeur illisible : conservée telle quelle, puis rejetée par validateConfig.
    const illisible = applyEnv(config(), { ANNONCES_RAYON_KM: 'beaucoup' });
    assert.equal(illisible.zone.rayon_km, 'beaucoup');
    assertInvalide(illisible, /zone\.rayon_km doit être un nombre > 0/);
  });

  test('toutes les variables reconnues sont appliquées au bon endroit, avec le bon type', () => {
    const env = {
      DISCORD_WEBHOOK_URL: 'https://discord.example/wh',
      TELEGRAM_BOT_TOKEN: 'tok',
      TELEGRAM_CHAT_ID: '42',
      ANNONCES_ZONE_MODE: 'departements',
      ANNONCES_VILLE: 'Lyon',
      ANNONCES_CODE_POSTAL: '69001',
      ANNONCES_LATITUDE: '45.76',
      ANNONCES_LONGITUDE: '4.83',
      ANNONCES_RAYON_KM: '30',
      ANNONCES_DEPARTEMENTS: '69,01',
      ANNONCES_AGE_MAX_MOIS: '5',
      ANNONCES_NOUVEAUX_JOURS: '2',
      ANNONCES_STATE_FILE: '/tmp/etat.json',
      ANNONCES_REPORTS_DIR: 'sorties',
    };
    assert.deepEqual(Object.keys(env).sort(), Object.keys(ENV_OVERRIDES).sort());
    const cfg = applyEnv(config(), env);
    assert.deepEqual(cfg.zone, {
      marge_departement_km: 25,
      mode: 'departements',
      centre: { ville: 'Lyon', code_postal: '69001', latitude: 45.76, longitude: 4.83 },
      rayon_km: 30,
      departements: ['69', '01'],
    });
    assert.equal(cfg.age_max_mois, 5);
    assert.equal(cfg.nouveaux_arrivants.jours, 2);
    assert.equal(cfg.etat.fichier, '/tmp/etat.json');
    assert.equal(cfg.notifications.fichier.dossier, 'sorties');
    assert.equal(cfg.notifications.telegram.chat_id, '42');
    validateConfig(cfg);
  });

  test('variables vides ou absentes ignorées, et la configuration reçue n\'est jamais modifiée', () => {
    const cfg = applyEnv(config(), { DISCORD_WEBHOOK_URL: '', ANNONCES_RAYON_KM: '', ANNONCES_VILLE: undefined });
    assert.deepEqual(cfg, config());
    assert.equal(cfg.notifications.discord.actif, false);
    // Renvoie une copie : la configuration reçue (ici DEFAULT_CONFIG) n'est pas modifiée.
    const avant = JSON.stringify(DEFAULT_CONFIG);
    const copie = applyEnv(DEFAULT_CONFIG, { DISCORD_WEBHOOK_URL: 'https://x', ANNONCES_DEPARTEMENTS: '13', ANNONCES_RAYON_KM: '5' });
    assert.notEqual(copie, DEFAULT_CONFIG);
    assert.equal(JSON.stringify(DEFAULT_CONFIG), avant);
  });

  test('ANNONCES_VILLE seule ne conserve pas le code postal hérité d\'une autre ville', () => {
    const cfg = applyEnv(config(), { ANNONCES_VILLE: 'Lyon' });
    assert.equal(cfg.zone.centre.ville, 'Lyon');
    assert.notEqual(cfg.zone.centre.code_postal, '75011');
  });
});

describe('validateConfig', () => {
  test('mode de zone invalide ("france" valide sans centre ni départements)', () => {
    assertInvalide(config({ zone: { mode: 'region' } }), /zone\.mode doit valoir 'rayon', 'departements' ou 'france' \(reçu : "region"\)/);
    // Le mode "france" n'exige ni centre ni départements.
    validateConfig(config({ zone: { mode: 'france', centre: null, departements: [] } }));
  });

  test('rayon_km ≤ 0 ou non numérique rejeté en mode rayon (mais ignoré en mode france)', () => {
    for (const rayon of [0, -5, '50', null]) {
      assertInvalide(config({ zone: { rayon_km: rayon } }), /zone\.rayon_km doit être un nombre > 0/);
    }
    validateConfig(config({ zone: { mode: 'france', rayon_km: 0 } }));
  });

  test('mode rayon : centre absent, code postal mal formé ou coordonnées non numériques', () => {
    assertInvalide(
      config({ zone: { centre: { ville: '', code_postal: null, latitude: null, longitude: null } } }),
      /zone\.centre : indiquez latitude\/longitude, ou ville, ou code_postal/,
    );
    assertInvalide(config({ zone: { centre: { code_postal: '7501' } } }), /zone\.centre\.code_postal doit comporter 5 chiffres/);
    assertInvalide(config({ zone: { centre: { latitude: 'nord', longitude: 2.35 } } }), /latitude\/longitude doivent être des nombres/);
    validateConfig(config({ zone: { centre: { ville: null, code_postal: null, latitude: 48.85, longitude: 2.35 } } }));
  });

  test('mode departements : liste vide, valeur qui n\'est pas un tableau, ou code invalide', () => {
    assertInvalide(config({ zone: { mode: 'departements', departements: [] } }), /zone\.departements doit être une liste non vide/);
    assertInvalide(config({ zone: { mode: 'departements', departements: '75' } }), /zone\.departements doit être une liste non vide/);
    assertInvalide(config({ zone: { mode: 'departements', departements: ['75', '2C', '1234'] } }), /code invalide « 2C »[\s\S]*code invalide « 1234 »/);
    validateConfig(config({ zone: { mode: 'departements', departements: ['01', '2A', '2b', '974'] } }));
  });

  test('age_max_mois ≤ 0 ou non numérique', () => {
    for (const age of [0, -1, '4', Number.NaN]) {
      assertInvalide(config({ age_max_mois: age }), /age_max_mois doit être un nombre > 0/);
    }
    validateConfig(config({ age_max_mois: 0.5 }));
  });

  test('nouveaux arrivants : jours négatif (0 accepté) ou critère invalide', () => {
    assertInvalide(config({ nouveaux_arrivants: { jours: -1 } }), /nouveaux_arrivants\.jours doit être un nombre ≥ 0/);
    validateConfig(config({ nouveaux_arrivants: { jours: 0 } }));
    assertInvalide(config({ nouveaux_arrivants: { critere: 'recent' } }), /nouveaux_arrivants\.critere doit valoir 'date_publication', 'premiere_vue' ou 'les_deux'/);
    for (const critere of ['date_publication', 'premiere_vue', 'les_deux']) validateConfig(config({ nouveaux_arrivants: { critere } }));
  });

  test('aucune source active ; pages_max < 1 avec Seconde Chance active', () => {
    assertInvalide(
      config({ sources: { laspa: { actif: false }, secondechance: { actif: false } } }),
      /Au moins une source doit être active/,
    );
    validateConfig(config({ sources: { laspa: { actif: false } } }));
    // pages_max < 1 n'est rejeté que si Seconde Chance est active.
    assertInvalide(config({ sources: { secondechance: { pages_max: 0 } } }), /sources\.secondechance\.pages_max doit être un entier ≥ 1/);
    validateConfig(config({ sources: { secondechance: { actif: false, pages_max: 0 } } }));
  });

  test('Discord actif sans URL de webhook ; Telegram actif sans chat_id ou sans jeton', () => {
    assertInvalide(config({ notifications: { discord: { actif: true, webhook_url: '' } } }), /notifications\.discord\.webhook_url est requis/);
    assertInvalide(config({ notifications: { telegram: { actif: true, bot_token: 'tok', chat_id: '' } } }), /bot_token et chat_id sont requis/);
    assertInvalide(config({ notifications: { telegram: { actif: true, bot_token: '', chat_id: '42' } } }), /bot_token et chat_id sont requis/);
  });

  test('heure de planification invalide (HH:MM, 00:00 à 23:59)', () => {
    for (const heure of ['24:00', '08:60', '8h00', '0800', '', null]) {
      assertInvalide(config({ planification: { heure } }), /planification\.heure doit être au format HH:MM/);
    }
    for (const heure of ['8:00', '00:00', '23:59']) validateConfig(config({ planification: { heure } }));
  });

  test('fuseau horaire inconnu', () => {
    assertInvalide(config({ planification: { fuseau: 'Mars/Olympus' } }), /planification\.fuseau inconnu : Mars\/Olympus/);
    validateConfig(config({ planification: { fuseau: 'America/Montreal' } }));
  });

  test('réglages http négatifs ou non numériques', () => {
    assertInvalide(config({ http: { timeout_ms: -1 } }), /http\.timeout_ms doit être un nombre ≥ 0/);
    assertInvalide(config({ http: { concurrence: 'quatre' } }), /http\.concurrence doit être un nombre ≥ 0/);
  });

  test('toutes les erreurs sont regroupées dans un seul message', () => {
    const cfg = config({ zone: { mode: 'x' }, age_max_mois: 0, planification: { heure: '25:00' } });
    assert.throws(() => validateConfig(cfg), (err) => {
      const lignes = err.message.split('\n').filter((l) => l.startsWith(' - '));
      assert.equal(lignes.length, 3);
      return true;
    });
  });
});

describe('loadConfig', () => {
  test('fichier temporaire : valeurs lues, commentaires "//" ignorés, défauts pour le reste, chemin journalisé', () => {
    const fichier = ecrireConfig('zone-lyon.json', {
      '//': 'commentaire racine',
      zone: { '//': 'commentaire zone', mode: 'departements', departements: ['69', '38'] },
      age_max_mois: 6,
      notifications: { console: false },
    });
    const logs = [];
    const cfg = loadConfig({ file: fichier, env: {}, log: (m) => logs.push(m) });
    assert.equal(cfg.zone.mode, 'departements');
    assert.deepEqual(cfg.zone.departements, ['69', '38']);
    assert.equal(cfg.age_max_mois, 6);
    assert.equal(cfg.notifications.console, false);
    assert.equal(Object.hasOwn(cfg, '//'), false);
    assert.equal(Object.hasOwn(cfg.zone, '//'), false);
    // Clés absentes du fichier : valeurs par défaut.
    assert.equal(cfg.zone.rayon_km, 50);
    assert.deepEqual(cfg.notifications.fichier, { actif: true, dossier: 'reports' });
    assert.deepEqual(cfg.planification, { heure: '08:00', fuseau: 'Europe/Paris' });
    assert.deepEqual(logs, [`Configuration : ${fichier}`]);
  });

  test('les surcharges (ligne de commande) l\'emportent sur le fichier', () => {
    const fichier = ecrireConfig('surcharges.json', { zone: { rayon_km: 80, departements: ['75'] }, nouveaux_arrivants: { jours: 14 } });
    const cfg = loadConfig({
      file: fichier,
      env: {},
      overrides: { zone: { rayon_km: 30, centre: { ville: 'Lyon', latitude: null, longitude: null } }, sources: { laspa: { actif: false } } },
    });
    assert.equal(cfg.zone.rayon_km, 30);
    assert.equal(cfg.zone.centre.ville, 'Lyon');
    assert.deepEqual(cfg.zone.departements, ['75']);
    assert.equal(cfg.nouveaux_arrivants.jours, 14);
    assert.equal(cfg.sources.laspa.actif, false);
    assert.equal(cfg.sources.secondechance.actif, true);
  });

  test('les variables d\'environnement l\'emportent sur le fichier', () => {
    const fichier = ecrireConfig('env.json', { zone: { rayon_km: 80 }, notifications: { discord: { actif: false, webhook_url: '' } } });
    const cfg = loadConfig({ file: fichier, env: { ANNONCES_RAYON_KM: '12,5', DISCORD_WEBHOOK_URL: 'https://discord.example/wh' } });
    assert.equal(cfg.zone.rayon_km, 12.5);
    assert.equal(cfg.notifications.discord.actif, true);
    assert.equal(cfg.notifications.discord.webhook_url, 'https://discord.example/wh');
  });

  test('normalisation : départements "1" → "01", 5 → "05", "2a" → "2A", " 75 " → "75" ; code postal et coordonnées typés', () => {
    const fichier = ecrireConfig('normalisation.json', {
      zone: { mode: 'departements', departements: ['1', 5, '2a', ' 75 ', '974'], centre: { code_postal: 69001, latitude: '45.76', longitude: '4.83' } },
    });
    const cfg = loadConfig({ file: fichier, env: {} });
    assert.deepEqual(cfg.zone.departements, ['01', '05', '2A', '75', '974']);
    assert.equal(cfg.zone.centre.code_postal, '69001');
    assert.equal(cfg.zone.centre.latitude, 45.76);
    assert.equal(cfg.zone.centre.longitude, 4.83);
  });

  test('normalisation appliquée aussi aux départements venant de l\'environnement : "69, 1" → ["69", "01"]', () => {
    const fichier = ecrireConfig('dep-env.json', { zone: { mode: 'departements' } });
    const cfg = loadConfig({ file: fichier, env: { ANNONCES_DEPARTEMENTS: '69, 1' } });
    assert.deepEqual(cfg.zone.departements, ['69', '01']);
  });

  test('fichier --config inexistant → erreur explicite', () => {
    const absent = path.join(dossier, 'nexiste-pas.json');
    assert.throws(() => loadConfig({ file: absent, env: {} }), { message: `Fichier de configuration introuvable : ${absent}` });
  });

  test('JSON illisible → « Impossible de lire » ; fichier incohérent → erreur de validation', () => {
    const fichier = ecrireConfig('casse.json', '{ "zone": { "mode": "rayon", } ');
    assert.throws(() => loadConfig({ file: fichier, env: {} }), (err) => {
      assert.match(err.message, /^Impossible de lire /);
      assert.ok(err.message.includes(fichier));
      return true;
    });
    // JSON correct mais incohérent → erreur de validation.
    const incoherent = ecrireConfig('invalide.json', { zone: { mode: 'departements', departements: [] }, planification: { fuseau: 'Nulle/Part' } });
    assert.throws(() => loadConfig({ file: incoherent, env: {} }), /Configuration invalide :[\s\S]*zone\.departements[\s\S]*fuseau inconnu : Nulle\/Part/);
  });

  test('sans config.json dans le dossier courant → valeurs par défaut et message d\'information', () => {
    const vide = path.join(dossier, 'vide');
    mkdirSync(vide, { recursive: true });
    const cwd = process.cwd();
    const logs = [];
    let cfg;
    try {
      process.chdir(vide);
      cfg = loadConfig({ env: {}, log: (m) => logs.push(m) });
    } finally {
      process.chdir(cwd);
    }
    assert.deepEqual(cfg, config());
    assert.equal(logs.length, 1);
    assert.match(logs[0], /Aucun config\.json trouvé/);
  });

  test('ne modifie pas DEFAULT_CONFIG (les normalisations portent sur une copie)', () => {
    const avant = JSON.stringify(DEFAULT_CONFIG);
    const fichier = ecrireConfig('mutation.json', { zone: { departements: ['1'], centre: { code_postal: 13001 } } });
    const cfg = loadConfig({ file: fichier, env: { ANNONCES_RAYON_KM: '5' } });
    cfg.zone.centre.ville = 'Marseille';
    cfg.zone.departements.push('13');
    assert.equal(JSON.stringify(DEFAULT_CONFIG), avant);
  });

  test('une option de ligne de commande l\'emporte sur la variable d\'environnement correspondante', () => {
    const fichier = ecrireConfig('cli-vs-env.json', {});
    const cfg = loadConfig({ file: fichier, env: { ANNONCES_RAYON_KM: '12' }, overrides: { zone: { rayon_km: 30 } } });
    assert.equal(cfg.zone.rayon_km, 30);
  });

  test('latitude/longitude vides ("") dans config.json traitées comme absentes, et non comme le point (0°, 0°)', () => {
    const fichier = ecrireConfig('coords-vides.json', { zone: { centre: { ville: 'Paris', code_postal: '75011', latitude: '', longitude: '' } } });
    const cfg = loadConfig({ file: fichier, env: {} });
    assert.equal(cfg.zone.centre.latitude, null);
    assert.equal(cfg.zone.centre.longitude, null);
  });
});
