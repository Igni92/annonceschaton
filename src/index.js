#!/usr/bin/env node
// Point d'entrée en ligne de commande.
//   node src/index.js                → une exécution immédiate
//   node src/index.js --loop         → exécution quotidienne à l'heure configurée (planification.heure)
//   node src/index.js --dry-run      → affiche le rapport sans notifier ni modifier l'état
//   node src/index.js --config x.json --rayon 30 --ville Lyon --age-max 6 --jours 3 --departements 69,01
import { loadConfig } from './config.js';
import { runOnce } from './run.js';
import { scheduleDaily } from './scheduler.js';

const HELP = `Usage : node src/index.js [options]

Options :
  --config <fichier>        Fichier de configuration (défaut : config.json)
  --loop                    Tourne en continu et s'exécute chaque jour à planification.heure
  --dry-run                 N'envoie rien (sauf console) et ne modifie pas l'état
  --quiet                   N'affiche pas le rapport dans la console
  --zone <mode>             rayon | departements | france
  --ville <nom>             Centre de la zone (mode rayon)
  --code-postal <cp>        Centre de la zone (mode rayon)
  --lat <x> --lon <y>       Centre de la zone (mode rayon)
  --rayon <km>              Rayon en km (mode rayon)
  --departements <liste>    ex. 75,92,93 (mode departements)
  --age-max <mois>          Âge maximal des chatons (défaut : 4)
  --jours <n>               Fenêtre « nouveaux arrivants » en jours
  --sans-laspa / --sans-secondechance   Désactive une source
  -h, --help                Cette aide
`;

function parseArgs(argv) {
  const out = { overrides: {} };
  const set = (keys, value) => {
    let cur = out.overrides;
    for (const k of keys.slice(0, -1)) cur = cur[k] ??= {};
    cur[keys.at(-1)] = value;
  };
  const num = (v, flag) => {
    const n = Number(String(v).replace(',', '.'));
    if (!Number.isFinite(n)) throw new Error(`Valeur numérique attendue pour ${flag} : ${v}`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`Valeur manquante pour ${a}`); i += 1; return argv[i]; };
    switch (a) {
      case '-h': case '--help': out.help = true; break;
      case '--loop': out.loop = true; break;
      case '--dry-run': out.dryRun = true; break;
      case '--quiet': set(['notifications', 'console'], false); break;
      case '--config': out.config = next(); break;
      case '--zone': set(['zone', 'mode'], next()); break;
      case '--ville': set(['zone', 'centre', 'ville'], next()); set(['zone', 'centre', 'latitude'], null); set(['zone', 'centre', 'longitude'], null); if (out.overrides.zone?.centre?.code_postal === undefined) set(['zone', 'centre', 'code_postal'], null); break;
      case '--code-postal': set(['zone', 'centre', 'code_postal'], next()); set(['zone', 'centre', 'latitude'], null); set(['zone', 'centre', 'longitude'], null); if (out.overrides.zone?.centre?.ville === undefined) set(['zone', 'centre', 'ville'], null); break;
      case '--lat': set(['zone', 'centre', 'latitude'], num(next(), a)); break;
      case '--lon': case '--lng': set(['zone', 'centre', 'longitude'], num(next(), a)); break;
      case '--rayon': set(['zone', 'rayon_km'], num(next(), a)); break;
      case '--departements': set(['zone', 'departements'], next().split(/[,\s;]+/).filter(Boolean)); break;
      case '--age-max': set(['age_max_mois'], num(next(), a)); break;
      case '--jours': set(['nouveaux_arrivants', 'jours'], num(next(), a)); break;
      case '--sans-laspa': set(['sources', 'laspa', 'actif'], false); break;
      case '--sans-secondechance': set(['sources', 'secondechance', 'actif'], false); break;
      default:
        throw new Error(`Option inconnue : ${a}\n\n${HELP}`);
    }
  }
  return out;
}

async function main() {
  // Sortie fermée en amont (ex. `| head`) : on quitte proprement au lieu de planter sur EPIPE.
  process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); throw err; });
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); return; }
  const log = (msg) => process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
  const config = loadConfig({ file: args.config ?? 'config.json', overrides: args.overrides, log });

  const task = () => runOnce(config, { dryRun: Boolean(args.dryRun), log });
  if (args.loop) {
    const controller = new AbortController();
    const stop = () => { log('Arrêt demandé.'); controller.abort(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    await scheduleDaily(config.planification, task, { log, signal: controller.signal });
  } else {
    const { errors } = await task();
    process.exitCode = errors.some((e) => e.startsWith('Source ')) ? 2 : 0;
  }
}

main().catch((err) => {
  process.stderr.write(`Erreur : ${err.message}\n`);
  process.exitCode = 1;
});
