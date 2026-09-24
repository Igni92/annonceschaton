// Mémoire du bot entre deux exécutions (fichier JSON) :
//  - `vus` : identifiants déjà rencontrés (pour détecter les nouveaux arrivants « jamais vus »)
//  - `fiches` : cache des informations coûteuses (date de naissance…) pour éviter de re-télécharger les fiches.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';

const VERSION = 1;
const MS_PER_DAY = 86_400_000;

export function emptyState() {
  return { version: VERSION, derniere_execution: null, vus: {}, fiches: {} };
}

/** Charge l'état depuis `file` ; état vide si le fichier n'existe pas ou est corrompu. */
export function loadState(file, log = () => {}) {
  try {
    const raw = readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') throw new Error('contenu invalide');
    return { ...emptyState(), ...data, vus: data.vus ?? {}, fiches: data.fiches ?? {} };
  } catch (err) {
    if (err.code !== 'ENOENT') log(`État illisible (${file}) : ${err.message} — on repart de zéro.`);
    return emptyState();
  }
}

/** Écrit l'état de façon atomique (fichier temporaire puis renommage). */
export function saveState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

/** Première date à laquelle `id` a été vu, ou null si inconnu. */
export function firstSeen(state, id) {
  return state.vus?.[id]?.premiere_vue ?? null;
}

/**
 * Marque les annonces comme vues aujourd'hui. Retourne l'ensemble des identifiants
 * qui n'avaient jamais été vus avant cet appel.
 */
export function markSeen(state, listings, now = new Date()) {
  const iso = now.toISOString();
  const fresh = new Set();
  for (const l of listings) {
    const entry = state.vus[l.id];
    if (!entry) {
      state.vus[l.id] = { premiere_vue: iso, derniere_vue: iso, source: l.source, nom: l.nom };
      fresh.add(l.id);
    } else {
      entry.derniere_vue = iso;
    }
  }
  return fresh;
}

/** Cache de fiche : lecture. */
export function getCachedFiche(state, id) {
  return state.fiches?.[id] ?? null;
}

/** Cache de fiche : écriture (on horodate pour la purge). */
export function setCachedFiche(state, id, data, now = new Date()) {
  state.fiches[id] = { ...data, mise_en_cache: now.toISOString() };
}

/** Supprime les entrées non revues depuis plus de `retentionDays` jours. */
export function pruneState(state, retentionDays = 90, now = new Date()) {
  const limit = now.getTime() - retentionDays * MS_PER_DAY;
  let removed = 0;
  for (const [id, entry] of Object.entries(state.vus)) {
    const last = Date.parse(entry.derniere_vue ?? entry.premiere_vue ?? 0);
    if (!Number.isFinite(last) || last < limit) {
      delete state.vus[id];
      delete state.fiches[id];
      removed += 1;
    }
  }
  for (const [id, entry] of Object.entries(state.fiches)) {
    if (!(id in state.vus)) {
      const t = Date.parse(entry.mise_en_cache ?? 0);
      if (!Number.isFinite(t) || t < limit) { delete state.fiches[id]; removed += 1; }
    }
  }
  return removed;
}
