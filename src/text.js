// Petits utilitaires texte / HTML (sans dépendance).

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', hellip: '…', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  agrave: 'à', acirc: 'â', auml: 'ä', ugrave: 'ù', ucirc: 'û', uuml: 'ü', ocirc: 'ô', ouml: 'ö',
  icirc: 'î', iuml: 'ï', ccedil: 'ç', oelig: 'œ', aelig: 'æ', Eacute: 'É', Egrave: 'È', Agrave: 'À',
  Ccedil: 'Ç', Ocirc: 'Ô', ndash: '–', mdash: '—', laquo: '«', raquo: '»', deg: '°', euro: '€',
  copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', times: '×',
};

/** Décode les entités HTML nommées, décimales et hexadécimales. */
export function decodeEntities(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in NAMED_ENTITIES ? NAMED_ENTITIES[name] : m));
}

/** Supprime les balises HTML et normalise les espaces. */
export function stripTags(html) {
  if (html == null) return '';
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Tronque proprement un texte à `max` caractères. */
export function truncate(str, max = 280) {
  if (str == null) return '';
  const s = String(str).trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Compare deux chaînes sans tenir compte de la casse ni des accents. */
export function normalize(str) {
  return String(str ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

/** Met en forme le sexe renvoyé par les sites : "male" | "femelle" | null. */
export function normalizeSex(value) {
  const s = normalize(value);
  if (!s) return null;
  if (s.startsWith('m')) return 'male';
  if (s.startsWith('f')) return 'femelle';
  return null;
}
