// Client HTTP minimal : fetch natif, délai d'attente, tentatives, limitation de concurrence, pause de politesse.

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sémaphore simple pour limiter le nombre de requêtes simultanées. */
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active -= 1; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

/** Masque les secrets présents dans une URL (jeton de bot Telegram, jeton de webhook Discord, paramètres). */
export function redactUrl(url) {
  try {
    const u = new URL(String(url));
    u.search = '';
    u.username = '';
    u.password = '';
    u.pathname = u.pathname
      .replace(/\/bot[^/]+/i, '/bot***')                 // api.telegram.org/bot<token>/…
      .replace(/(\/webhooks\/[^/]+\/)[^/]+/i, '$1***');  // discord.com/api/webhooks/<id>/<token>
    return u.toString();
  } catch {
    return String(url).replace(/[?#].*$/, '').replace(/\/bot[^/]+/i, '/bot***').replace(/(\/webhooks\/[^/]+\/)[^/]+/i, '$1***');
  }
}

export class HttpError extends Error {
  constructor(message, { status = null, url = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url ?? null; // brut (les messages, eux, sont masqués via redactUrl)
  }
}

const backoffMs = (attempt) => Math.min(8000, 500 * 2 ** (attempt - 1));

/**
 * @param {object} opts
 * @param {string} opts.userAgent
 * @param {number} [opts.timeoutMs=30000]  couvre l'attente des en-têtes ET la lecture du corps
 * @param {number} [opts.retries=3]        nombre total de tentatives
 * @param {number} [opts.concurrency=4]
 * @param {number} [opts.delayMs=250]      pause minimale entre deux départs de requête (politesse)
 * @param {Function} [opts.fetchImpl]      pour les tests
 * @param {Function} [opts.log]
 */
export function createHttp({
  userAgent = 'annonceschaton-bot/1.0',
  timeoutMs = 30_000,
  retries = 3,
  concurrency = 4,
  delayMs = 250,
  fetchImpl = globalThis.fetch,
  log = () => {},
} = {}) {
  const limit = createLimiter(Math.max(1, concurrency));
  const stats = { requests: 0, retries: 0, failures: 0 };
  let nextSlot = 0; // instant (ms) du prochain départ autorisé

  /** Attend son tour pour respecter delayMs, y compris entre requêtes concurrentes. */
  async function pace() {
    const start = Math.max(Date.now(), nextSlot);
    nextSlot = start + delayMs;
    const wait = start - Date.now();
    if (wait > 0) await sleep(wait);
  }

  /** Une tentative : renvoie { status, text } ou lève HttpError. Le délai couvre en-têtes + corps. */
  async function attempt(url, headers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { headers, redirect: 'follow', signal: controller.signal });
      const text = await res.text();
      return { status: res.status, ok: res.ok, text };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (controller.signal.aborted || err?.name === 'AbortError') {
        throw new HttpError(`Délai dépassé (${timeoutMs} ms) pour ${redactUrl(url)}`, { url });
      }
      throw new HttpError(`Erreur réseau pour ${redactUrl(url)} : ${err?.message ?? err}`, { url });
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(url, { headers = {}, accept } = {}) {
    const allHeaders = { 'user-agent': userAgent, 'accept-language': 'fr-FR,fr;q=0.9', ...(accept ? { accept } : {}), ...headers };
    const max = Math.max(1, retries);
    let lastError = null;
    for (let n = 1; n <= max; n += 1) {
      await pace();
      stats.requests += 1;
      try {
        const res = await attempt(url, allHeaders);
        if (res.ok) return res;
        lastError = new HttpError(`HTTP ${res.status} pour ${redactUrl(url)}`, { status: res.status, url });
        if (!RETRYABLE_STATUS.has(res.status)) break;
      } catch (err) {
        lastError = err;
      }
      if (n < max) {
        stats.retries += 1;
        log(`Nouvelle tentative (${n}/${max}) dans ${backoffMs(n)} ms : ${lastError.message}`);
        await sleep(backoffMs(n));
      }
    }
    stats.failures += 1;
    throw lastError ?? new HttpError(`Échec inconnu pour ${redactUrl(url)}`, { url });
  }

  return {
    stats,
    /** GET → texte (HTML). */
    getText: (url, opts = {}) => limit(async () => (await request(url, { ...opts, accept: 'text/html,*/*;q=0.8' })).text),
    /** GET → JSON. */
    getJson: (url, opts = {}) => limit(async () => {
      const res = await request(url, { ...opts, accept: 'application/json,*/*;q=0.8' });
      try {
        return JSON.parse(res.text);
      } catch {
        stats.failures += 1;
        throw new HttpError(`Réponse non JSON pour ${redactUrl(url)} : ${res.text.slice(0, 120)}…`, { url, status: res.status });
      }
    }),
  };
}

/**
 * POST JSON avec tentatives (utilisé par Discord/Telegram) — indépendant du limiteur GET.
 * Les messages d'erreur ne contiennent jamais les jetons présents dans l'URL.
 */
export async function postJson(url, body, { userAgent = 'annonceschaton-bot/1.0', timeoutMs = 15_000, retries = 3, fetchImpl = globalThis.fetch, headers = {} } = {}) {
  const max = Math.max(1, retries);
  let lastError = null;
  for (let n = 1; n <= max; n += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let waitMs = backoffMs(n);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': userAgent, ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.ok) return res;
      const text = await res.text().catch(() => '');
      lastError = new HttpError(`HTTP ${res.status} pour ${redactUrl(url)} : ${text.slice(0, 200)}`, { status: res.status, url });
      if (!RETRYABLE_STATUS.has(res.status)) throw lastError;
      const retryAfter = Number(res.headers?.get?.('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) waitMs = Math.max(waitMs, retryAfter * 1000);
    } catch (err) {
      if (err instanceof HttpError && !RETRYABLE_STATUS.has(err.status)) throw err;
      if (!(err instanceof HttpError)) {
        lastError = controller.signal.aborted || err?.name === 'AbortError'
          ? new HttpError(`Délai dépassé (${timeoutMs} ms) pour ${redactUrl(url)}`, { url })
          : new HttpError(`Erreur réseau pour ${redactUrl(url)} : ${err?.message ?? err}`, { url });
      }
    } finally {
      clearTimeout(timer);
    }
    if (n < max) await sleep(waitMs);
  }
  throw lastError;
}
