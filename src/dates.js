// Dates civiles dans un fuseau horaire donné (sans dépendance).

/** « YYYY-MM-DD » de l'instant `now` dans le fuseau `fuseau`. */
export function localIsoDate(now = new Date(), fuseau = 'Europe/Paris') {
  const parts = new Intl.DateTimeFormat('fr-CA', { timeZone: fuseau, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Ajoute `days` jours (négatif accepté) à une date civile « YYYY-MM-DD ». */
export function addDaysIso(iso, days) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + Number(days)));
  return date.toISOString().slice(0, 10);
}
