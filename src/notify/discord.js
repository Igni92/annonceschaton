// Notification : webhook Discord (messages ≤ 2000 caractères, découpés si besoin).
import { postJson } from '../http.js';

const LIMIT = 2000;

/** Découpe un texte en morceaux ≤ limit sans couper au milieu d'une ligne (sauf ligne trop longue). */
export function chunkText(text, limit = LIMIT) {
  const chunks = [];
  let current = '';
  for (const line of String(text).split('\n')) {
    const piece = line.length > limit ? line.slice(0, limit - 1) + '…' : line;
    if ((current + (current ? '\n' : '') + piece).length > limit) {
      if (current) chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function notifyDiscord(report, { webhook_url, userAgent, fetchImpl } = {}) {
  if (!webhook_url) throw new Error('Discord : webhook_url manquant');
  const chunks = chunkText(report.markdown, LIMIT);
  for (const [i, content] of chunks.entries()) {
    await postJson(webhook_url, { content, username: 'Annonces chatons' }, { userAgent, fetchImpl });
    if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 400)); // limite de débit Discord
  }
  return { canal: 'discord', ok: true, messages: chunks.length };
}
