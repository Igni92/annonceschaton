// Mise en forme du rapport quotidien (texte, Markdown, HTML Telegram, JSON).
import { formatAge } from './age.js';

const SEX_LABEL = { male: '♂ mâle', femelle: '♀ femelle' };

function fmtDate(iso, locale = 'fr-FR') {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
}

function lieuLine(l) {
  const lieu = l.lieu ?? {};
  const parts = [];
  const depAssoc = lieu.departement_association ?? (lieu.precision === 'exacte' ? lieu.departement : null);
  const villeDep = [lieu.ville, depAssoc ? `(${depAssoc})` : null].filter(Boolean).join(' ');
  if (lieu.nom) parts.push(lieu.nom);
  if (villeDep && !(lieu.nom ?? '').toLowerCase().includes((lieu.ville ?? '\u0000').toLowerCase())) parts.push(villeDep);
  else if (!lieu.ville && depAssoc) parts.push(`(${depAssoc})`);
  if (lieu.precision === 'departement') {
    const deps = (lieu.departements_adoption?.length ? lieu.departements_adoption : [lieu.departement]).filter(Boolean);
    if (deps.length && deps.join(',') !== String(depAssoc ?? '')) parts.push(`adoptable dans le ${deps.join(', ')}`);
  } else if (lieu.distance_km != null) {
    parts.push(`${Math.round(lieu.distance_km)} km`);
  }
  return parts.join(' · ');
}

function ageLine(l) {
  const age = formatAge(l.age_mois, { precis: Boolean(l.date_naissance) });
  return l.date_naissance ? `${age} (né·e le ${fmtDate(l.date_naissance)})` : age;
}

/** Représentation d'une annonce sous forme de champs prêts à afficher. */
export function describe(l) {
  return {
    nom: l.nom || '(sans nom)',
    source: l.source_label ?? l.source,
    age: ageLine(l),
    sexe: SEX_LABEL[l.sexe] ?? null,
    race: l.race ?? null,
    lieu: lieuLine(l),
    publication: l.date_publication ? `mis en ligne le ${fmtDate(l.date_publication)}` : null,
    reserve: l.reserve ? 'réservé·e' : null,
    url: l.url,
    description: l.description ?? null,
  };
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function itemMarkdown(l) {
  const d = describe(l);
  const meta = [d.age, d.sexe, d.race, d.reserve].filter(Boolean).join(' · ');
  const lines = [`- **[${d.nom}](${d.url})** — ${meta}`];
  if (d.lieu) lines.push(`  📍 ${d.lieu}`);
  if (d.publication) lines.push(`  🗓 ${d.publication} · ${d.source}`); else lines.push(`  🏷 ${d.source}`);
  return lines.join('\n');
}

function itemText(l) {
  const d = describe(l);
  const meta = [d.age, d.sexe, d.race, d.reserve].filter(Boolean).join(' · ');
  const lines = [`• ${d.nom} — ${meta}`];
  if (d.lieu) lines.push(`    📍 ${d.lieu}`);
  lines.push(`    ${[d.publication, d.source].filter(Boolean).join(' · ')}`);
  lines.push(`    ${d.url}`);
  return lines.join('\n');
}

function itemHtml(l) {
  const d = describe(l);
  const meta = [d.age, d.sexe, d.race, d.reserve].filter(Boolean).map(esc).join(' · ');
  const lines = [`• <a href="${esc(d.url)}"><b>${esc(d.nom)}</b></a> — ${meta}`];
  if (d.lieu) lines.push(`   📍 ${esc(d.lieu)}`);
  lines.push(`   ${esc([d.publication, d.source].filter(Boolean).join(' · '))}`);
  return lines.join('\n');
}

/**
 * @param {object} args
 * @param {object[]} args.kittens
 * @param {object[]} args.newcomers
 * @param {object} args.config
 * @param {object} args.zone
 * @param {Date} args.now
 * @param {object} [args.stats]
 * @param {string[]} [args.errors]
 */
export function buildReport({ kittens, newcomers, config, zone, now = new Date(), stats = {}, errors = [] }) {
  const dateStr = now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: config.planification?.fuseau ?? 'Europe/Paris' });
  const titre = `Annonces chatons — ${dateStr}`;
  const maxAge = config.age_max_mois;
  const na = config.nouveaux_arrivants;
  const critereLabel = na.critere === 'date_publication'
    ? `mis en ligne depuis ${na.jours} jour${na.jours > 1 ? 's' : ''}`
    : na.critere === 'premiere_vue' ? 'jamais vus par le bot' : `mis en ligne depuis ${na.jours} jour${na.jours > 1 ? 's' : ''} ou jamais vus`;
  const kittenIds = new Set(kittens.map((l) => l.id));
  const newcomersOnly = newcomers.filter((l) => !kittenIds.has(l.id));

  const sections = [
    { emoji: '🐾', titre: `Chatons de moins de ${maxAge} mois`, items: kittens, vide: 'Aucun chaton correspondant aujourd\'hui.' },
    { emoji: '🆕', titre: `Nouveaux arrivants (${critereLabel})`, items: newcomersOnly, vide: 'Aucun nouvel arrivant.', note: kittens.length && newcomers.length !== newcomersOnly.length ? `${newcomers.length - newcomersOnly.length} chaton(s) ci-dessus sont aussi des nouveaux arrivants.` : null },
  ];

  const sourcesLabel = Object.entries(config.sources).filter(([, v]) => v?.actif).map(([k]) => (k === 'laspa' ? 'La SPA' : 'Seconde Chance')).join(' + ');
  const footer = [`Zone : ${zone.label}`, `Sources : ${sourcesLabel}`];
  if (stats.requests != null) footer.push(`${stats.requests} requêtes HTTP`);

  const markdown = [
    `# ${titre}`, '',
    ...sections.flatMap((s) => [
      `## ${s.emoji} ${s.titre} (${s.items.length})`, '',
      ...(s.items.length ? s.items.map(itemMarkdown) : [`_${s.vide}_`]),
      ...(s.note ? ['', `_${s.note}_`] : []), '',
    ]),
    ...(errors.length ? ['## ⚠️ Avertissements', '', ...errors.map((e) => `- ${e}`), ''] : []),
    `---`, `_${footer.join(' · ')}_`, '',
  ].join('\n');

  const text = [
    titre, '='.repeat(titre.length), '',
    ...sections.flatMap((s) => [
      `${s.emoji} ${s.titre.toUpperCase()} (${s.items.length})`, '',
      ...(s.items.length ? s.items.map(itemText) : [`  ${s.vide}`]),
      ...(s.note ? ['', `  ${s.note}`] : []), '',
    ]),
    ...(errors.length ? ['⚠️ AVERTISSEMENTS', ...errors.map((e) => `  - ${e}`), ''] : []),
    footer.join(' · '), '',
  ].join('\n');

  const html = [
    `<b>${esc(titre)}</b>`, '',
    ...sections.flatMap((s) => [
      `<b>${s.emoji} ${esc(s.titre)} (${s.items.length})</b>`, '',
      ...(s.items.length ? s.items.map(itemHtml) : [`<i>${esc(s.vide)}</i>`]),
      ...(s.note ? ['', `<i>${esc(s.note)}</i>`] : []), '',
    ]),
    ...(errors.length ? ['<b>⚠️ Avertissements</b>', ...errors.map((e) => `- ${esc(e)}`), ''] : []),
    `<i>${esc(footer.join(' · '))}</i>`,
  ].join('\n');

  const json = {
    date: now.toISOString(),
    zone: { mode: zone.mode, label: zone.label, centre: zone.centre ? { latitude: zone.centre.latitude, longitude: zone.centre.longitude } : null, rayon_km: zone.rayon_km, departements: zone.departements },
    parametres: { age_max_mois: maxAge, nouveaux_arrivants: na, inclure_reserves: config.inclure_reserves },
    chatons: kittens.map(stripInternal),
    nouveaux_arrivants: newcomers.map(stripInternal),
    stats, erreurs: errors,
  };

  return { titre, markdown, text, html, json, compte: { chatons: kittens.length, nouveaux: newcomersOnly.length } };
}

function stripInternal(l) {
  const { _now, ...rest } = l;
  return rest;
}
