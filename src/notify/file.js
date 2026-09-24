// Notification : écriture des rapports sur disque (Markdown + JSON), avec un « latest » toujours à jour.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export async function notifyFile(report, { dossier = 'reports', now = new Date(), fuseau = 'Europe/Paris' } = {}) {
  mkdirSync(dossier, { recursive: true });
  const day = localDate(now, fuseau);
  const md = path.join(dossier, `${day}.md`);
  const json = path.join(dossier, `${day}.json`);
  writeFileSync(md, report.markdown);
  writeFileSync(json, JSON.stringify(report.json, null, 2));
  writeFileSync(path.join(dossier, 'latest.md'), report.markdown);
  writeFileSync(path.join(dossier, 'latest.json'), JSON.stringify(report.json, null, 2));
  return { canal: 'fichier', ok: true, fichiers: [md, json] };
}

/** « YYYY-MM-DD » dans le fuseau demandé. */
export function localDate(now, fuseau = 'Europe/Paris') {
  const parts = new Intl.DateTimeFormat('fr-CA', { timeZone: fuseau, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
