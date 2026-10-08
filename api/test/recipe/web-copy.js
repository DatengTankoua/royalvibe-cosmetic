/**
 * 1-14D.2H — Copie ISOLÉE des sources web pour le build et le serveur de la
 * recette (TEST).
 *
 * Next 16 (`@next/env`) charge les `.env*` du répertoire du projet, et le
 * binaire natif (Turbopack) embarque son propre lecteur dotenv, hors de
 * portée d'une garde JavaScript. Le build et `next start` s'exécutent donc
 * dans une copie temporaire qui NE CONTIENT AUCUN `.env*` : ces fichiers sont
 * écartés sur leur seul NOM (listing du répertoire), sans jamais être
 * ouverts, copiés ni « stat-és ». `web/.next` du dépôt n'est pas touché.
 *
 * Seules les entrées listées ci-dessous sont copiées ; `node_modules` est une
 * jonction vers `web/node_modules` (résolution des dépendances installées,
 * aucune installation).
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** Entrées de premier niveau nécessaires au build (liste fermée). */
const WEB_ENTRIES = Object.freeze([
  'src',
  'public',
  'package.json',
  'next.config.ts',
  'next-env.d.ts',
  'tsconfig.json',
  'postcss.config.mjs',
]);

const ENV_FILE = /^\.env($|\.)/i;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.next', '.git']);

/**
 * Copie récursive : chaque nom est examiné AVANT toute opération sur le
 * fichier. Retourne les noms écartés (sans aucune lecture de contenu).
 */
function copyTree(source, target, excluded) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    if (ENV_FILE.test(entry.name)) {
      excluded.push(from);
      continue;
    }
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name))
        copyTree(from, path.join(target, entry.name), excluded);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, path.join(target, entry.name));
    }
    // Liens et autres types : ignorés (aucun attendu dans les sources).
  }
}

/** Liste des `.env*` présents dans un arbre (noms seulement). */
function findEnvFiles(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (ENV_FILE.test(entry.name))
        found.push(path.join(directory, entry.name));
      else if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name))
        walk(path.join(directory, entry.name));
    }
  };
  walk(root);
  return found;
}

/**
 * Prépare `target` (supprimé puis recréé) à partir de `sourceWeb`.
 * `nodeModules` : dossier `node_modules` à relier (jonction).
 */
function prepareIsolatedWeb(sourceWeb, target, nodeModules) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  const excluded = [];
  // Racine : seules les entrées de la liste fermée, jamais un `.env*`.
  const rootNames = new Set(fs.readdirSync(sourceWeb));
  for (const name of rootNames) {
    if (ENV_FILE.test(name)) excluded.push(path.join(sourceWeb, name));
  }
  for (const name of WEB_ENTRIES) {
    if (!rootNames.has(name)) continue;
    const from = path.join(sourceWeb, name);
    const stat = fs.lstatSync(from);
    if (stat.isDirectory()) copyTree(from, path.join(target, name), excluded);
    else if (stat.isFile()) fs.copyFileSync(from, path.join(target, name));
  }
  fs.symlinkSync(nodeModules, path.join(target, 'node_modules'), 'junction');
  const remaining = findEnvFiles(target);
  if (remaining.length > 0) {
    throw new Error(
      `Copie web non isolée : ${remaining.length} fichier(s) .env* présent(s).`,
    );
  }
  return {
    target,
    excludedEnvFiles: excluded.map((f) => path.relative(sourceWeb, f)),
  };
}

/** Supprime la copie : la jonction est retirée SANS suivre sa cible. */
function removeIsolatedWeb(target) {
  const link = path.join(target, 'node_modules');
  try {
    if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
  } catch {
    // absente
  }
  fs.rmSync(target, { recursive: true, force: true });
}

module.exports = {
  WEB_ENTRIES,
  ENV_FILE,
  prepareIsolatedWeb,
  removeIsolatedWeb,
  findEnvFiles,
};
