// Envoi du rapport sur tous les canaux actifs. Une erreur sur un canal n'empêche pas les autres.
import { notifyConsole } from './console.js';
import { notifyFile } from './file.js';
import { notifyDiscord } from './discord.js';
import { notifyTelegram } from './telegram.js';

/**
 * @returns {Promise<Array<{canal:string, ok:boolean, erreur?:string}>>}
 */
export async function notifyAll(report, config, { now = new Date(), dryRun = false, log = () => {}, fetchImpl } = {}) {
  const n = config.notifications ?? {};
  const results = [];
  const run = async (canal, fn) => {
    try {
      results.push(await fn());
      log(`Notification ${canal} : OK`);
    } catch (err) {
      results.push({ canal, ok: false, erreur: err.message });
      log(`Notification ${canal} : ÉCHEC — ${err.message}`);
    }
  };

  if (n.console !== false) await run('console', () => notifyConsole(report));
  if (dryRun) {
    log('Mode --dry-run : rapport non envoyé (fichier/Discord/Telegram).');
    return results;
  }
  if (n.fichier?.actif) await run('fichier', () => notifyFile(report, { dossier: n.fichier.dossier, now, fuseau: config.planification?.fuseau }));
  const userAgent = config.http?.user_agent;
  if (n.discord?.actif) await run('discord', () => notifyDiscord(report, { webhook_url: n.discord.webhook_url, userAgent, fetchImpl }));
  if (n.telegram?.actif) await run('telegram', () => notifyTelegram(report, { bot_token: n.telegram.bot_token, chat_id: n.telegram.chat_id, userAgent, fetchImpl }));
  return results;
}
