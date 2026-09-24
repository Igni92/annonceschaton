# annonceschaton 🐾

Petit bot qui récupère **chaque jour** les annonces d'adoption de **chatons de moins de 4 mois** et les **nouveaux arrivants** dans une **zone géographique** de votre choix, puis vous envoie un rapport (console, fichier, Discord ou Telegram).

Toutes les variables (zone, âge maximal, fenêtre « nouveaux arrivants », sources, notifications, heure d'exécution…) sont modifiables dans `config.json`, par variables d'environnement ou en ligne de commande.

Sources interrogées :

| Source | Méthode | Ce qu'on en tire |
| --- | --- | --- |
| [la-spa.fr](https://www.la-spa.fr/adoption/) | **fetch** de l'API JSON publique du site (aucun scraping HTML) | tous les chats des refuges SPA, date de mise en ligne, date de naissance exacte (via la fiche), coordonnées GPS du refuge |
| [secondechance.org](https://www.secondechance.org/animal/adopter-un-chat) | **scraping léger** des pages HTML (recherche par département) | chats des associations, âge, département où l'animal est adoptable, date de naissance et association (via la fiche) |

Aucune dépendance npm : Node.js ≥ 20 suffit (`fetch` natif).

## Prérequis

Node.js version 20 ou plus. Vérifiez avec `node --version`. Si la commande n'est pas reconnue :

- **Windows** : installez la version LTS depuis [nodejs.org](https://nodejs.org/fr/download) (ou, dans un terminal, `winget install OpenJS.NodeJS.LTS`), puis **fermez et rouvrez** l'invite de commandes.
- **macOS** : `brew install node` ou l'installeur de nodejs.org.
- **Linux** : `sudo apt install nodejs` (Debian/Ubuntu) ou l'installeur de nodejs.org.

## Démarrage rapide

Sous Windows (invite de commandes ou PowerShell) :

```bat
git clone https://github.com/Igni92/annonceschaton.git
cd annonceschaton
copy config.example.json config.json
node src\index.js --dry-run
node src\index.js
```

Sous Linux / macOS :

```bash
git clone https://github.com/Igni92/annonceschaton.git
cd annonceschaton
cp config.example.json config.json   # puis adaptez la zone, l'âge, etc.
node src/index.js --dry-run          # affiche le rapport sans rien envoyer ni mémoriser
node src/index.js                    # exécution réelle : rapport + notifications + mémoire des annonces vues
```

`--dry-run` affiche le rapport sans rien envoyer ni mémoriser ; sans option, le bot envoie les notifications et mémorise les annonces vues. Éditez ensuite `config.json` (zone, âge, notifications…) avec n'importe quel éditeur de texte.

Exemples sans toucher au fichier de configuration :

```bash
node src/index.js --ville Lyon --rayon 30 --age-max 6
node src/index.js --zone departements --departements 69,01,38 --jours 3
node src/index.js --lat 43.6 --lon 1.44 --rayon 25 --sans-secondechance
node src/index.js --help
```

## Interface graphique

Pour choisir ses critères sans éditer de fichier, lancez l'interface locale (elle ouvre votre navigateur sur `http://127.0.0.1:3939/`) :

```bat
node src\ui\server.js
```

(ou `npm run ui`). Vous pouvez y régler la zone, l'âge, les nouveaux arrivants, les sources et les notifications, **enregistrer** dans `config.json`, lancer un **aperçu** (rien n'est envoyé ni mémorisé) ou une **exécution réelle**, tester Discord/Telegram, et consulter le rapport avec les photos. L'interface n'est accessible que depuis votre ordinateur. Options : `--port 4000`, `--config autre.json`, `--no-open`.

## Configuration (`config.json`)

Copiez `config.example.json` en `config.json`. Toutes les clés sont facultatives : une clé absente prend la valeur par défaut de `src/config.js`.

| Clé | Défaut | Rôle |
| --- | --- | --- |
| `zone.mode` | `"rayon"` | `rayon` (autour d'un point), `departements` (liste) ou `france` (aucun filtre) |
| `zone.centre.ville` / `code_postal` / `latitude` / `longitude` | Paris 75011 | Centre du rayon. Coordonnées > ville (géocodage [api-adresse.data.gouv.fr](https://adresse.data.gouv.fr/api-doc/adresse)) > code postal (chef-lieu du département) |
| `zone.rayon_km` | `50` | Rayon en km (mode `rayon`) |
| `zone.departements` | `["75","92","93","94"]` | Codes département (mode `departements`), ex. `"2A"`, `"974"` |
| `zone.marge_departement_km` | `25` | Tolérance pour les annonces localisées seulement au département (voir « Précision géographique ») |
| `age_max_mois` | `4` | Un chaton est retenu si son âge est **strictement inférieur** à cette valeur |
| `nouveaux_arrivants.jours` | `7` | Fenêtre « mis en ligne depuis N jours » |
| `nouveaux_arrivants.critere` | `"les_deux"` | `date_publication`, `premiere_vue` (jamais vu par le bot) ou `les_deux` |
| `nouveaux_arrivants.tous_ages` | `false` | `false` : seuls les nouveaux **chatons** sont signalés (badge « nouveau » dans la liste). `true` : les nouveaux arrivants de tous âges ont leur propre section |
| `inclure_reserves` | `false` | Inclure les animaux marqués « réservé » |
| `portees.actif` | `true` | Regrouper les chatons d'une même portée (frères et sœurs) |
| `portees.taille_min` | `2` | Nombre minimal de chatons pour former une portée |
| `portees.tolerance_jours` | `3` | Écart maximal entre dates de naissance d'une même portée |
| `portees.seulement` | `false` | `true` pour ne signaler que les portées (masque les chatons seuls) |
| `sources.laspa.actif` | `true` | Interroger la SPA |
| `sources.laspa.categories_age` | `["junior"]` | Catégories demandées à la SPA : `junior` (moins d'un an), `adult`, `senior`. Par défaut seuls les moins d'un an sont téléchargés |
| `sources.secondechance.actif` | `true` | Interroger Seconde Chance |
| `sources.secondechance.adoptable_hors_departement` | `false` | Inclure les associations acceptant l'adoption hors département |
| `sources.secondechance.pages_max` | `10` | Pages de résultats lues au maximum par département et par recherche |
| `sources.secondechance.fiches_details` | `true` | Lire la fiche des chatons potentiels (date de naissance, association) |
| `sources.secondechance.departements` | — | Force la liste des départements interrogés (sinon déduite de la zone) |
| `notifications.console` | `true` | Rapport texte sur la sortie standard |
| `notifications.fichier` | actif, dossier `reports/` | `reports/AAAA-MM-JJ.md` + `.json` et `reports/latest.*` |
| `notifications.discord` | inactif | Webhook Discord (`webhook_url`) |
| `notifications.telegram` | inactif | Bot Telegram (`bot_token`, `chat_id`) |
| `planification.heure` / `fuseau` | `"08:00"` / `"Europe/Paris"` | Heure d'exécution du mode `--loop` |
| `http.*` | UA, 30 s, 3 tentatives, 4 requêtes simultanées, 250 ms | Politesse réseau |
| `etat.fichier` / `retention_jours` | `data/state.json` / `90` | Mémoire des annonces vues et cache des fiches |

Variables d'environnement (prioritaires sur `config.json`, voir `.env.example`) : `DISCORD_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (activent le canal automatiquement), `ANNONCES_ZONE_MODE`, `ANNONCES_VILLE`, `ANNONCES_CODE_POSTAL`, `ANNONCES_LATITUDE`, `ANNONCES_LONGITUDE`, `ANNONCES_RAYON_KM`, `ANNONCES_DEPARTEMENTS`, `ANNONCES_AGE_MAX_MOIS`, `ANNONCES_NOUVEAUX_JOURS`, `ANNONCES_STATE_FILE`, `ANNONCES_REPORTS_DIR`.

## Exécution quotidienne

Trois façons, au choix :

1. **Boucle interne** — le processus reste lancé et s'exécute chaque jour à `planification.heure` :
   ```bash
   node src/index.js --loop
   ```
   (à mettre dans un service systemd, `pm2`, ou une fenêtre `screen`/`tmux`).

2. **cron** (Linux/macOS) — tous les jours à 8 h :
   ```cron
   0 8 * * * cd /chemin/vers/annonceschaton && /usr/bin/node src/index.js --quiet >> bot.log 2>&1
   ```
   Sous Windows : Planificateur de tâches → *Créer une tâche de base* → déclencheur « Tous les jours » à 8 h → action « Démarrer un programme » avec programme `node`, arguments `src\index.js --quiet`, et « Commencer dans » = le dossier du dépôt (ex. `C:\Users\maxym\annonceschaton`).

3. **GitHub Actions** — le workflow `.github/workflows/daily.yml` tourne à 06:00 UTC, envoie les notifications, dépose le rapport en artefact et mémorise `data/state.json` + `reports/latest.*` dans le dépôt. Dans *Settings → Secrets and variables → Actions* :
   - secrets : `DISCORD_WEBHOOK_URL` et/ou `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` ;
   - variables (facultatives) : `ANNONCES_VILLE`, `ANNONCES_CODE_POSTAL`, `ANNONCES_RAYON_KM`, `ANNONCES_ZONE_MODE`, `ANNONCES_DEPARTEMENTS`, `ANNONCES_AGE_MAX_MOIS`, `ANNONCES_NOUVEAUX_JOURS`.
   Vous pouvez aussi committer un `config.json` (il est ignoré par git par défaut : retirez-le de `.gitignore` si besoin).

## Notifications

- **Discord** : créez un webhook sur le salon voulu (*Paramètres du salon → Intégrations → Webhooks*) et renseignez `notifications.discord.webhook_url` ou `DISCORD_WEBHOOK_URL`.
- **Telegram** : créez un bot avec [@BotFather](https://t.me/BotFather), envoyez-lui un message, puis récupérez votre `chat_id` (par exemple via `https://api.telegram.org/bot<TOKEN>/getUpdates`). Renseignez `bot_token` et `chat_id`.
- Les messages trop longs sont découpés automatiquement (2000 caractères Discord, 4096 Telegram).

## Comment ça marche

1. **Zone** — le centre est résolu (coordonnées, géocodage de la ville, ou chef-lieu du code postal).
2. **La SPA** — l'API renvoie les chats « junior » (moins d'un an ; filtre serveur ≈ 100 km quand le rayon le permet, sinon tout le site) ; on garde ceux dont le refuge est dans la zone ; leur âge n'étant pas affiché dans la liste, on lit la fiche pour obtenir la date de naissance, toujours présente pour les juniors (mise en cache dans `data/state.json`).
3. **Seconde Chance** — pour chaque département de la zone : recherche « Bébé » (0–5 mois ; « Junior » ajouté si `age_max_mois` > 6) sur toutes les pages, puis recherche tous âges page par page en s'arrêtant dès qu'une page ne contient que des annonces déjà vues (les résultats sont triés du plus récent au plus ancien). La fiche est lue pour les chatons potentiels et les annonces jamais vues.
4. **Âge** — la date de naissance, quand elle existe, fait foi. Sinon l'âge affiché par le site, sauf « 0 mois » sur Seconde Chance, qui signifie « non renseigné ». Dans ce cas la **description** est analysée (« GILMORE 6 ANS », « âgée de 3 mois et demi », « née le 12 juin »…), en tenant compte du temps écoulé depuis la mise en ligne (une description écrite il y a deux mois pour un chaton de 2 mois décrit un chat de 4 mois). Une description qui contredit fortement l'âge affiché (« il a 6 ans » pour une carte « 2 mois ») l'emporte, et le conflit est signalé dans le JSON (`age_conflit`). Un animal dont l'âge reste inconnu n'est jamais compté comme chaton.
5. **Filtres** — chatons : âge connu `< age_max_mois` ; nouveaux arrivants : mis en ligne depuis `jours` jours et/ou jamais vus par le bot. Les animaux « réservés » sont exclus par défaut.
6. **Portées** — pour adopter des frères et sœurs, les chatons sont regroupés par portée d'après plusieurs indices : même refuge ou association et même date de naissance (à `tolerance_jours` près, indice fort) ; nom d'un autre chaton cité dans la description (« sa sœur Mia », indice fort) ; annonce à plusieurs noms (« Dean et Gareth ») ; même âge affiché et même date de mise en ligne sans date de naissance (« portée probable »). Le rapport affiche chaque portée avec sa taille, le nombre encore disponible et les indices retenus (`portees` dans le JSON).
7. **Rapport** — Markdown (fichier/Discord), texte (console), HTML (Telegram), JSON (`reports/*.json` pour vos propres traitements).
8. **Mémoire** — `data/state.json` retient les annonces vues (détection des nouveautés) et les fiches lues (moins de requêtes le lendemain). Au **premier lancement**, la mémoire est vide : les nouveaux arrivants sont alors déterminés d'après la date de mise en ligne uniquement ; la détection « jamais vu » devient effective dès le deuxième jour.

### Précision géographique

- La SPA fournit les coordonnées GPS de chaque refuge : la distance affichée est exacte.
- Seconde Chance n'indique que le **département où l'animal est adoptable** (l'association peut avoir son siège ailleurs). En mode `rayon`, on interroge les départements dont le chef-lieu est à moins de `rayon_km + marge_departement_km` du centre ; le rapport affiche « adoptable dans le NN » quand ce département diffère de celui de l'association.

## Tests

```bash
npm test
```

Les tests s'appuient sur des copies de pages/réponses réelles dans `test/fixtures/` : aucun accès réseau n'est nécessaire.

## Limites connues

- Les sites peuvent changer de structure : `docs/SOURCES.md` décrit précisément ce que le code attend, pour faciliter la mise à jour.
- Un même animal peut apparaître deux fois quand un refuge SPA publie aussi sur Seconde Chance.
- Sur Seconde Chance, la « date de mise en ligne » est en réalité la date de dernière mise à jour de la fiche.
- Le géocodage en ligne (api-adresse.data.gouv.fr) est facultatif : en cas d'échec, le bot se replie sur le chef-lieu du code postal.

Merci de garder des réglages raisonnables (`http.concurrence`, `http.delai_ms`) : ces sites sont gérés par des associations.
