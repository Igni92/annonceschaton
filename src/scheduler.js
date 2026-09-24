// Planificateur interne : exécute une fonction chaque jour à HH:MM dans un fuseau donné.

/** Composantes date/heure locales de `date` dans `timeZone`. */
function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** Décalage (ms) entre l'heure locale du fuseau et UTC à l'instant `date`. */
function tzOffsetMs(date, timeZone) {
  const p = localParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Prochaine occurrence de « HH:MM » (fuseau `timeZone`) strictement après `from`.
 * @returns {Date}
 */
export function nextOccurrence(heure, timeZone, from = new Date()) {
  const [hh, mm] = String(heure).split(':').map(Number);
  const p = localParts(from, timeZone);
  for (let addDays = 0; addDays <= 2; addDays += 1) {
    // Instant « naïf » puis correction du décalage (gère les changements d'heure).
    let guess = new Date(Date.UTC(p.year, p.month - 1, p.day + addDays, hh, mm, 0));
    guess = new Date(guess.getTime() - tzOffsetMs(guess, timeZone));
    // Deuxième passe pour stabiliser autour d'un changement d'heure.
    guess = new Date(Date.UTC(p.year, p.month - 1, p.day + addDays, hh, mm, 0) - tzOffsetMs(guess, timeZone));
    if (guess.getTime() > from.getTime()) return guess;
  }
  throw new Error(`Impossible de calculer la prochaine occurrence de ${heure} (${timeZone})`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Boucle infinie : attend la prochaine occurrence puis exécute `task`. Ne s'arrête que sur SIGINT/SIGTERM.
 */
export async function scheduleDaily({ heure, fuseau }, task, { log = console.error, signal } = {}) {
  log(`Planification : tous les jours à ${heure} (${fuseau}). Ctrl+C pour arrêter.`);
  while (!signal?.aborted) {
    const next = nextOccurrence(heure, fuseau);
    log(`Prochaine exécution : ${next.toLocaleString('fr-FR', { timeZone: fuseau })}`);
    let remaining = next.getTime() - Date.now();
    while (remaining > 0 && !signal?.aborted) {
      await sleep(Math.min(remaining, 60 * 60 * 1000)); // réveils horaires (évite les dérives longues)
      remaining = next.getTime() - Date.now();
    }
    if (signal?.aborted) break;
    try {
      await task();
    } catch (err) {
      log(`Exécution en échec : ${err.stack ?? err.message}`);
    }
  }
}
