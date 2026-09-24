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
    .replace(/[̀-ͯ]/g, '') // enlève les accents
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
