// Analyse des âges et dates de naissance renvoyés par les sites.
// Formats rencontrés :
//   la-spa.fr   : age_number = "3 ans" | "1 an" | "N/A" ; fiche : birthday = "Né(e) le 2026-07-01" | null
//   secondechance.org : "EUROPÉEN Mâle - 2 mois" | "3 ans" | "6 semaines" ; fiche : "Date de naissance : 01/03/2026"

const MS_PER_DAY = 86_400_000;
const DAYS_PER_MONTH = 365.25 / 12; // ≈ 30.44 jours

/** Nombre de mois (décimal) écoulés entre `birth` et `now`. */
export function monthsBetween(birth, now = new Date()) {
  const days = (now.getTime() - birth.getTime()) / MS_PER_DAY;
  return days / DAYS_PER_MONTH;
}

/**
 * Extrait une date de naissance depuis un texte libre.
 * Accepte "Né(e) le 2026-07-01", "2026-07-01", "Date de naissance : 01/03/2026", "01/03/2026".
 * @returns {Date|null} date UTC à minuit, ou null si absente / invalide.
 */
export function parseBirthDate(text) {
  if (text == null) return null;
  const s = String(text);
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  let y, mo, d;
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else {
    m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (!m) return null;
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  // Rejette les dates impossibles (ex. 31/02) que Date "corrige" silencieusement.
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}

/** Formate une Date en "YYYY-MM-DD" (UTC). */
export function toIsoDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * Convertit un âge textuel ("3 mois", "1 an", "2 ans", "6 semaines", "3 mois et demi", "N/A")
 * en nombre de mois. Retourne null si l'information est absente ou inconnue.
 */
export function parseAgeToMonths(text) {
  if (text == null) return null;
  const s = String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // enlève les accents
    .replace(',', '.')
    .trim();
  if (!s || s === 'n/a' || s === 'na' || s === 'inconnu' || s === '-') return null;

  let months = 0;
  let found = false;

  const years = s.match(/(\d+(?:\.\d+)?)\s*(?:ans?|annees?)\b/);
  if (years) { months += Number(years[1]) * 12; found = true; }

  const mois = s.match(/(\d+(?:\.\d+)?)\s*mois\b/);
  if (mois) {
    let v = Number(mois[1]);
    if (/mois\s+et\s+demi/.test(s)) v += 0.5;
    months += v;
    found = true;
  }

  const weeks = s.match(/(\d+(?:\.\d+)?)\s*(?:semaines?|sem\.?)\b/);
  if (weeks) { months += Number(weeks[1]) * 7 / DAYS_PER_MONTH; found = true; }

  const days = s.match(/(\d+(?:\.\d+)?)\s*(?:jours?)\b/);
  if (days) { months += Number(days[1]) / DAYS_PER_MONTH; found = true; }

  return found ? months : null;
}

/**
 * Détermine l'âge en mois le plus précis possible :
 * la date de naissance si connue, sinon le texte d'âge.
 */
export function bestAgeInMonths({ birthDate = null, ageText = null }, now = new Date()) {
  if (birthDate instanceof Date && !Number.isNaN(birthDate.getTime())) {
    const m = monthsBetween(birthDate, now);
    return m < 0 ? 0 : m;
  }
  return parseAgeToMonths(ageText);
}

/**
 * Formate un âge en mois pour l'affichage : "3 mois", "1 an", "2 ans 3 mois", "3 semaines".
 * Sans date de naissance précise (`precis = false`), un âge < 1 mois s'affiche « moins d'un mois ».
 */
export function formatAge(months, { precis = false } = {}) {
  if (months == null || Number.isNaN(months)) return 'âge inconnu';
  if (months < 1) {
    if (!precis) return "moins d'un mois";
    const weeks = Math.max(1, Math.round(months * DAYS_PER_MONTH / 7));
    return `${weeks} semaine${weeks > 1 ? 's' : ''}`;
  }
  const whole = Math.floor(months);
  if (whole < 12) return `${whole} mois`;
  const years = Math.floor(whole / 12);
  const rest = whole % 12;
  const y = `${years} an${years > 1 ? 's' : ''}`;
  return rest ? `${y} ${rest} mois` : y;
}

// ---------------------------------------------------------------------------
// Âge déduit d'une description libre (« GILMORE 6 ANS », « âgée de 3 mois », « né le 12 juin 2026 »…).
// Sert à compléter un âge non renseigné (« 0 mois » sur secondechance.org) ou à détecter une contradiction.
// ---------------------------------------------------------------------------

const MOIS_FR = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];
const UNITE_RE = '(ans?|annees?|mois|semaines?|sem\\.?|jours?)';
// Contextes (dans la même proposition, avant le nombre) où « N mois / N ans » ne désigne PAS l'âge de l'animal :
// durée (« depuis 2 ans », « pendant 3 mois »), événement passé (« stérilisée à 6 mois », « arrivé à 3 semaines »),
// bornes (« plus de 2 ans »), fréquence (« tous les ans »), conditions (« contrat de 2 mois »).
const EXCLUSION_RE = /(depuis|il y a|voila|voici|pendant|durant|des l'age|a l'age|vers l'age|jusqu'a|jusqu'aux|avant|apres|tous les|toutes les|chaque|plus de|moins de|maximum|minimum|au moins|au plus|garantie|contrat|delai|quarantaine|periode|essai|sterilis|castr|vaccin|puce|identifi|arriv|recueil|trouv|abandonn|sauv|secour|adopt|rendu|retour|attend|cherch|refuge depuis|en famille d'accueil depuis|foyer depuis|pension|traitement|convalescence|sevr|avait|etait|alors|lorsqu|quand|a l'epoque|autrefois|certificat|sign|date|reflexion|engagement|bebe de|petits? de|dans les|d'ici|a ses|a leurs|aura|auront|sera|seront|fois)[^.;!?]*$/;

function uniteEnMois(n, unite) {
  const u = unite.toLowerCase();
  if (u.startsWith('an')) return n * 12;
  if (u.startsWith('mois')) return n;
  if (u.startsWith('sem')) return n * 7 / DAYS_PER_MONTH;
  return n / DAYS_PER_MONTH; // jours
}

/**
 * Cherche l'âge de l'animal dans un texte libre.
 * @param {string} text
 * @param {Date} [now]
 * @returns {{mois:number, extrait:string, fiabilite:'forte'|'faible', date_naissance?:string}|null}
 */
export function ageFromDescription(text, now = new Date()) {
  if (!text) return null;
  const brut = String(text).replace(/[\u2019\u2018\u02bc]/g, "'").replace(/\s+/g, ' ').trim();
  const s = brut.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (!s) return null;
  const extrait = (i, len = 40) => { const a = Math.max(0, i - 20), b = Math.min(brut.length, i + len); return brut.slice(a, b).replace(/^[\udc00-\udfff]/, '').replace(/[\ud800-\udbff]$/, '').trim(); };

  // 1) Date de naissance explicite : « né(e) le 12 juin 2026 », « nés le 01/03/2026 », « née en mars 2026 », « né début juin ».
  const nais = s.match(/\bn[e]e?s?\s+(?:le\s+|en\s+|debut\s+|mi[- ]|fin\s+|courant\s+|vers\s+le\s+)?(?:(\d{1,2})(?:er)?\s+)?(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)(?:\s+(\d{4}))?/)
    ?? s.match(/\bn[e]e?s?\s+(?:le\s+)?(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (nais) {
    let y, m, d;
    if (MOIS_FR.includes(nais[2])) {
      m = MOIS_FR.indexOf(nais[2]) + 1;
      d = nais[1] ? Number(nais[1]) : 15;
      y = nais[3] ? Number(nais[3]) : now.getUTCFullYear();
      if (!nais[3] && Date.UTC(y, m - 1, d) > now.getTime()) y -= 1; // « né le 12 juin » sans année : l'année passée si futur
    } else {
      [d, m, y] = [Number(nais[1]), Number(nais[2]), Number(nais[3])];
    }
    const date = new Date(Date.UTC(y, m - 1, d));
    if (!Number.isNaN(date.getTime()) && date.getTime() <= now.getTime() + 86_400_000 && now.getTime() - date.getTime() < 30 * 365.25 * 86_400_000) {
      return { mois: Math.max(0, monthsBetween(date, now)), extrait: extrait(nais.index, nais[0].length + 10), fiabilite: 'forte', date_naissance: toIsoDate(date) };
    }
  }

  const num = (v) => Number(String(v).replace(',', '.'));
  const demi = (i, len) => /^\s*et\s*demie?/.test(s.slice(i + len)) ? 0.5 : 0;
  // « 1 an et 10 mois » : mois complémentaires juste après une valeur en années.
  const complement = (i, len, unite) => {
    if (!/^an/.test(unite.toLowerCase())) return 0;
    const m2 = s.slice(i + len).match(/^\s*(?:et\s+)?(\d{1,2})\s*mois\b/);
    return m2 ? Number(m2[1]) : 0;
  };

  // 2) Formulations fortes : « âgé(e) de N », « il/elle a N ans », « NOM, N ans », « (N ans) », « N ANS » en capitales.
  const fortes = [
    new RegExp(`\\bag[e]e?s?\\s+d[e']\\s*(?:environ\\s+|tout\\s+juste\\s+|a\\s+peine\\s+|presque\\s+|bientot\\s+)?(\\d+(?:[.,]\\d+)?)\\s*${UNITE_RE}`),
    new RegExp(`\\b(?:il|elle|qui)\\s+(?:a|vient\\s+d'avoir|n'a\\s+que)\\s+(?:environ\\s+|tout\\s+juste\\s+|a\\s+peine\\s+|presque\\s+|bientot\\s+|deja\\s+)?(\\d+(?:[.,]\\d+)?)\\s*${UNITE_RE}`),
    new RegExp(`\\(\\s*(\\d+(?:[.,]\\d+)?)\\s*${UNITE_RE}\\s*(?:et demie?)?\\s*\\)`),
    new RegExp(`\\b(\\d+(?:[.,]\\d+)?)\\s*(ANS?|MOIS|SEMAINES?)\\b`), // capitales : testé sur le texte brut ci-dessous
    new RegExp(`\\b[A-Z][A-Za-z-]{1,25}\\s+a\\s+(?:environ\\s+|tout\\s+juste\\s+|a\\s+peine\\s+|presque\\s+|bientot\\s+|deja\\s+)?(\\d+(?:[.,]\\d+)?)\\s*(ans?|mois|semaines?)\\b`), // « Caramel a 6 semaines » : nom propre, testé sur le texte brut sans accents
    new RegExp(`^.{0,60}?[,:–-]\\s*(?:environ\\s+|tout\\s+juste\\s+)?(\\d+(?:[.,]\\d+)?)\\s*${UNITE_RE}\\b`), // « Gilmore, 6 ans … » en tête
    new RegExp(`\\b(?:chatons?|chattes?|chats?|minous?|matous?|petite?s?|jeunes?|femelles?|males?|loulous?|minettes?|boules? de poils?)\\s+(?:de|d')\\s*(?:environ\\s+|tout\\s+juste\\s+|a\\s+peine\\s+)?(\\d+(?:[.,]\\d+)?)\\s*${UNITE_RE}`),
    new RegExp(`\\b(\\d+(?:[.,]\\d+)?)\\s*${UNITE_RE}\\s*et\\s*demie?\\b`),
  ];
  for (const [idx, re] of fortes.entries()) {
    // motif 3 (capitales) : texte brut sans accents ; motif 4 (nom propre + « a ») : texte brut AVEC accents,
    // pour que « Stérilisée à 6 mois » (à ≠ a) ne passe pas.
    const cible = idx === 3 ? brut.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : idx === 4 ? brut : s;
    const m = cible.match(re);
    if (!m) continue;
    if (idx === 4 && /^(st[ée]rilis|vaccin|castr|trouv|arriv|adopt|recueil|puc|identifi|sauv|abandonn|rendu|retour|test|visible|disponible|adoptable|placee?|op[ée]r)/i.test(m[0])) continue;
    const i = m.index + m[0].search(/\d/);
    if (/(depuis|il y a|voila|voici|pendant|durant|jusqu'a|plus de|moins de|alors|lorsqu|quand|a l'epoque|avait|etait)[^.;!?]{0,25}$/.test(s.slice(Math.max(0, i - 30), i))) continue;
    const n = num(m[1]);
    if (!Number.isFinite(n) || n > 30 * 12) continue;
    const len = m[0].length - m[0].search(/\d/);
    return { mois: uniteEnMois(n + demi(i, len), m[2]) + complement(i, len, m[2]), extrait: extrait(i), fiabilite: 'forte' };
  }

  // 3) Formulation faible : premier « N ans / N mois / N semaines » hors contexte exclu.
  const faible = new RegExp('\\b(\\d+(?:[.,]\\d+)?)\\s*(ans?|annees?|mois|semaines?)\\b', 'g');
  let m;
  while ((m = faible.exec(s)) !== null) {
    const i = m.index;
    if (EXCLUSION_RE.test(s.slice(Math.max(0, i - 60), i))) continue;
    if (/^\s*(de|d')\s*(vie|garantie|contrat|traitement|quarantaine|convalescence|sevrage|pension|essai)/.test(s.slice(i + m[0].length))) continue;
    const n = num(m[1]);
    if (!Number.isFinite(n) || n > 30 * 12) continue;
    return { mois: uniteEnMois(n + demi(i, m[0].length), m[2]) + complement(i, m[0].length, m[2]), extrait: extrait(i), fiabilite: 'faible' };
  }
  return null;
}

/**
 * Combine les informations d'âge disponibles pour une annonce et signale les contradictions.
 * Règles :
 *  - une date de naissance connue l'emporte ;
 *  - sinon l'âge structuré (carte / fiche), sauf s'il vaut 0 ou est absent (non renseigné) ;
 *  - la description complète un âge inconnu ; si elle contredit fortement un âge structuré « chaton »
 *    (formulation forte, ≥ 12 mois), c'est elle qui l'emporte : mieux vaut manquer un chaton qu'annoncer un adulte.
 *  - l'âge lu dans la description date de sa rédaction : on lui ajoute le temps écoulé depuis `asOf`
 *    (date de mise en ligne / de mise à jour de l'annonce) quand elle est connue.
 * @returns {{age_mois:number|null, age_source:'naissance'|'fiche'|'description'|null, age_conflit:string|null, date_naissance:string|null}}
 */
export function resolveAge({ birthDate = null, ageText = null, description = null, asOf = null, now = new Date() } = {}) {
  if (birthDate instanceof Date && !Number.isNaN(birthDate.getTime())) {
    return { age_mois: Math.max(0, monthsBetween(birthDate, now)), age_source: 'naissance', age_conflit: null, date_naissance: toIsoDate(birthDate) };
  }
  const structure = parseAgeToMonths(ageText);
  const structureConnu = structure != null && structure > 0; // « 0 mois » = non renseigné
  const desc = ageFromDescription(description, now);
  if (desc && !desc.date_naissance) {
    const ref = asOf instanceof Date ? asOf : (typeof asOf === 'string' && /^\d{4}-\d{2}-\d{2}/.test(asOf) ? new Date(`${asOf.slice(0, 10)}T00:00:00Z`) : null);
    if (ref && !Number.isNaN(ref.getTime()) && ref.getTime() < now.getTime()) desc.mois += monthsBetween(ref, now);
  }
  if (desc?.date_naissance) {
    return { age_mois: desc.mois, age_source: 'description', age_conflit: structureConnu && Math.abs(structure - desc.mois) > 6 ? `fiche : ${ageText} · description : ${desc.extrait}` : null, date_naissance: desc.date_naissance };
  }
  if (structureConnu) {
    if (desc && desc.fiabilite === 'forte' && desc.mois >= 12 && structure < 12) {
      return { age_mois: desc.mois, age_source: 'description', age_conflit: `fiche : ${ageText} · description : ${desc.extrait}`, date_naissance: null };
    }
    return { age_mois: structure, age_source: 'fiche', age_conflit: null, date_naissance: null };
  }
  if (desc) return { age_mois: desc.mois, age_source: 'description', age_conflit: null, date_naissance: null };
  return { age_mois: null, age_source: null, age_conflit: null, date_naissance: null };
}
