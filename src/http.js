// Client HTTP minimal : fetch natif, délai d'attente, tentatives, limitation de concurrence.

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

export class HttpError extends Error {
  constructor(message, { status = null, url = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.userAgent
 * @param {number} [opts.timeoutMs=30000]
 * @param {number} [opts.retries=3]      nombre total de tentatives
 * @param {number} [opts.concurrency=4]
 * @param {number} [opts.delayMs=250]    pause minimale entre deux requêtes (politesse)
 * @param {Function} [opts.fetchImpl]    pour les tests
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
  let lastStart = 0;

  async function request(url, { headers = {}, accept } = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= Math.max(1, retries); attempt += 1) {
      const wait = lastStart + delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
      stats.requests += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, {
          headers: { 'user-agent': userAgent, 'accept-language': 'fr-FR,fr;q=0.9', ...(accept ? { accept } : {}), ...headers },
          redirect: 'follow',
          signal: controller.signal,
        });
        if (!res.ok) {
          const err = new HttpError(`HTTP ${res.status} pour ${url}`, { status: res.status, url });
          if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
            lastError = err;
            stats.retries += 1;
            const backoff = Math.min(8000, 500 * 2 ** (attempt - 1));
            log(`Nouvelle tentative (${attempt}/${retries}) dans ${backoff} ms : ${err.message}`);
            await sleep(backoff);
            continue;
          }
          throw err;
        }
        return res;
      } catch (err) {
        if (err instanceof HttpError) throw err;
        lastError = err.name === 'AbortError'
          ? new HttpError(`Délai dépassé (${timeoutMs} ms) pour ${url}`, { url })
          : new HttpError(`Erreur réseau pour ${url} : ${err.message}`, { url });
        if (attempt < retries) {
          stats.retries += 1;
          const backoff = Math.min(8000, 500 * 2 ** (attempt - 1));
          log(`Nouvelle tentative (${attempt}/${retries}) dans ${backoff} ms : ${lastError.message}`);
          await sleep(backoff);
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    stats.failures += 1;
    throw lastError ?? new HttpError(`Échec inconnu pour ${url}`, { url });
  }

  return {
    stats,
    /** GET → texte (HTML). */
    getText: (url, opts = {}) => limit(async () => (await request(url, { ...opts, accept: 'text/html,*/*;q=0.8' })).text()),
    /** GET → JSON. */
    getJson: (url, opts = {}) => limit(async () => {
      const res = await request(url, { ...opts, accept: 'application/json,*/*;q=0.8' });
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new HttpError(`Réponse non JSON pour ${url} : ${text.slice(0, 120)}…`, { url, status: res.status });
      }
    }),
  };
}

/**
 * POST JSON avec tentatives (utilisé par Discord/Telegram) — indépendant du limiteur GET.
 */
export async function postJson(url, body, { userAgent = 'annonceschaton-bot/1.0', timeoutMs = 15_000, retries = 3, fetchImpl = globalThis.fetch, headers = {} } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': userAgent, ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.ok) return res;
      const text = await res.text().catch(() => '');
      lastError = new HttpError(`HTTP ${res.status} pour ${url} : ${text.slice(0, 200)}`, { status: res.status, url });
      if (!RETRYABLE_STATUS.has(res.status)) throw lastError;
      let waitMs = Math.min(8000, 500 * 2 ** (attempt - 1));
      const retryAfter = Number(res.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) waitMs = Math.max(waitMs, retryAfter * 1000);
      await sleep(waitMs);
    } catch (err) {
      if (err instanceof HttpError && !RETRYABLE_STATUS.has(err.status)) throw err;
      lastError = err instanceof HttpError ? err : new HttpError(`Erreur réseau pour ${url} : ${err.message}`, { url });
      if (attempt < retries) await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}
