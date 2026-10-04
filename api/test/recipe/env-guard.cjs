/**
 * 1-14D.2H — Garde anti-`.env` de la recette locale (TEST UNIQUEMENT).
 *
 * Préchargée dans CHAQUE processus de la recette (lanceur, migrations,
 * fixtures, API, build et serveur web, CLI) par `--require` / `NODE_OPTIONS`.
 * Toute tentative d'accès à un fichier dont le nom commence par `.env`
 * (`.env`, `.env.local`, `.env.production`…) échoue comme un fichier ABSENT
 * (`ENOENT`) : aucun contenu n'est lu, quel que soit le module appelant
 * (`@nestjs/config`, `dotenv`, `@next/env`…). Les tentatives sont seulement
 * NOMMÉES dans un journal (`RECIPE_ENV_GUARD_LOG`), jamais leur contenu.
 *
 * Ce fichier ne fait partie d'aucun binaire de production.
 */
'use strict';

const fs = require('fs');
const path = require('path');

if (!globalThis.__STOCKMASTER_RECIPE_ENV_GUARD__) {
  globalThis.__STOCKMASTER_RECIPE_ENV_GUARD__ = true;

  const ENV_FILE = /^\.env($|\.)/i;
  const logFile = process.env.RECIPE_ENV_GUARD_LOG;
  const original = {
    appendFileSync: fs.appendFileSync,
  };

  const targetName = (target) => {
    if (typeof target === 'string') return path.basename(target);
    if (Buffer.isBuffer(target)) return path.basename(target.toString());
    if (target instanceof URL && target.protocol === 'file:') {
      return path.basename(decodeURIComponent(target.pathname));
    }
    return null; // descripteur numérique : rien à contrôler
  };

  // 1-15A — exception OPTIONNELLE (absente par défaut) : préfixes absolus
  // de dossiers créés par un test pour ses PROPRES `.env` factices (ex.
  // `%TEMP%/reconcile-cli-14d2g-`). Jamais un dossier du dépôt.
  const allowedPrefixes = (process.env.RECIPE_ENV_GUARD_ALLOW_PREFIXES || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((prefix) => path.resolve(prefix));

  const isAllowed = (target) => {
    if (allowedPrefixes.length === 0) return false;
    let full;
    if (typeof target === 'string') full = path.resolve(target);
    else if (Buffer.isBuffer(target)) full = path.resolve(target.toString());
    else if (target instanceof URL && target.protocol === 'file:')
      full = path.resolve(decodeURIComponent(target.pathname));
    else return false;
    return allowedPrefixes.some((prefix) => full.startsWith(prefix));
  };

  const isEnvFile = (target) => {
    const name = targetName(target);
    return name !== null && ENV_FILE.test(name) && !isAllowed(target);
  };

  const record = (operation, target) => {
    if (!logFile) return;
    try {
      original.appendFileSync(
        logFile,
        `${JSON.stringify({
          pid: process.pid,
          operation,
          file: targetName(target),
          directory: path.dirname(String(target)),
        })}\n`,
      );
    } catch {
      // Journal facultatif : ne jamais faire échouer le processus.
    }
  };

  const enoent = (operation, target) => {
    const error = new Error(
      `ENOENT: blocked by recipe env guard, ${operation} '${targetName(target)}'`,
    );
    error.code = 'ENOENT';
    error.errno = -2;
    error.syscall = operation;
    return error;
  };

  const SYNC = [
    'readFileSync',
    'statSync',
    'lstatSync',
    'openSync',
    'accessSync',
    'createReadStream',
  ];
  for (const name of SYNC) {
    const fn = fs[name];
    if (typeof fn !== 'function') continue;
    fs[name] = function guarded(target, ...rest) {
      if (isEnvFile(target)) {
        record(name, target);
        throw enoent(name, target);
      }
      return fn.call(this, target, ...rest);
    };
  }

  const existsSync = fs.existsSync;
  fs.existsSync = function guardedExists(target) {
    if (isEnvFile(target)) {
      record('existsSync', target);
      return false;
    }
    return existsSync.call(this, target);
  };

  const CALLBACK = ['readFile', 'stat', 'lstat', 'open', 'access'];
  for (const name of CALLBACK) {
    const fn = fs[name];
    if (typeof fn !== 'function') continue;
    fs[name] = function guardedCallback(target, ...rest) {
      if (isEnvFile(target)) {
        record(name, target);
        const callback = [...rest]
          .reverse()
          .find((v) => typeof v === 'function');
        const error = enoent(name, target);
        if (callback) process.nextTick(() => callback(error));
        return undefined;
      }
      return fn.call(this, target, ...rest);
    };
  }

  const PROMISES = ['readFile', 'stat', 'lstat', 'open', 'access'];
  for (const name of PROMISES) {
    const fn = fs.promises[name];
    if (typeof fn !== 'function') continue;
    fs.promises[name] = function guardedPromise(target, ...rest) {
      if (isEnvFile(target)) {
        record(`promises.${name}`, target);
        return Promise.reject(enoent(name, target));
      }
      return fn.call(this, target, ...rest);
    };
  }

  // Imports ESM nommés (`import { readFileSync } from 'fs'`) alignés.
  require('module').syncBuiltinESMExports();
}
