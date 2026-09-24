// Notification : Bot Telegram (sendMessage, HTML, ≤ 4096 caractères par message).
import { postJson } from '../http.js';
import { chunkText } from './discord.js';

const LIMIT = 4096;

export async function notifyTelegram(report, { bot_token, chat_id, userAgent, fetchImpl } = {}) {
  if (!bot_token || !chat_id) throw new Error('Telegram : bot_token ou chat_id manquant');
  const url = `https://api.telegram.org/bot${bot_token}/sendMessage`;
  const chunks = chunkText(report.html, LIMIT);
  for (const text of chunks) {
    const res = await postJson(url, { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true }, { userAgent, fetchImpl });
    const body = await res.json().catch(() => ({}));
    if (body && body.ok === false) throw new Error(`Telegram : ${body.description ?? 'réponse invalide'}`);
  }
  return { canal: 'telegram', ok: true, messages: chunks.length };
}
