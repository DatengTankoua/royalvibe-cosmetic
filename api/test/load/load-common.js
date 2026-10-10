/**
 * 1-20A — Constantes, gardes et profils de la campagne de charge (TEST).
 *
 * Réutilise la recette locale (`../recipe/recipe-common.js`) : environnement
 * des enfants construit variable par variable, garde anti-`.env` préchargée,
 * chien de garde du lanceur. Tout est FICTIF et STRICTEMENT LOCAL :
 * - cible HTTP et Socket.IO : 127.0.0.1 uniquement (`assertLocalTarget`) ;
 * - MongoDB : instance éphémère créée par le lanceur, base dédiée
 *   `stockmaster_load` (`assertLoadUri`) ;
 * - e-mails, stockage objet et transport push : simulés.
 */
'use strict';

const os = require('os');
const path = require('path');
const R = require('../recipe/recipe-common');

const HOST = '127.0.0.1';
const PORTS = Object.freeze({ api: 4300, control: 4399, storage: 4398 });
const API_URL = `http://${HOST}:${PORTS.api}`;
const CONTROL_URL = `http://${HOST}:${PORTS.control}`;
const STORAGE_URL = `http://${HOST}:${PORTS.storage}`;
const STORAGE_BUCKET = 'load-fictitious';
const DB_NAME = 'stockmaster_load';
const PASSWORD = 'Charge-locale-1-20a!';
const JWT_SECRET = 'load-1-20a-fictitious-jwt-secret-not-production';
/** Origine fictive autorisée par le CORS de l'API de charge (aucun web). */
const WEB_ORIGIN = 'http://127.0.0.1:3300';

const STATE_DIR = path.join(os.tmpdir(), 'stockmaster-load-1-20a');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
const LOG_DIR = path.join(STATE_DIR, 'logs');
const WORK_DIR = path.join(STATE_DIR, 'cwd');
const METRICS_API = path.join(STATE_DIR, 'metrics-api.jsonl');
const METRICS_DB = path.join(STATE_DIR, 'metrics-db.jsonl');
const METRICS_PROC = path.join(STATE_DIR, 'metrics-proc.jsonl');
const PUSH_FILE = path.join(STATE_DIR, 'push.jsonl');
const MAIL_FILE = path.join(STATE_DIR, 'mail.jsonl');
const PHASE_FILE = path.join(STATE_DIR, 'phase.txt');

/**
 * Bornes de ressources de la campagne (hypothèses de TEST, pas la
 * configuration Railway) : tas V8 de l'API, cache WiredTiger.
 */
const LIMITS = Object.freeze({
  apiHeapMb: 1024,
  wiredTigerCacheGb: 0.5,
});

/**
 * Profils de données DÉTERMINISTES (hypothèses de test, jamais des
 * statistiques réelles de Stock Master). `standard` : entreprises
 * ordinaires ; `concentrated` : une entreprise avec beaucoup de vendeurs.
 */
const PROFILES = Object.freeze({
  current: {
    standard: {
      count: 5,
      admins: 1,
      sellers: 3,
      sections: 8,
      products: 150,
      sales: 3000,
      notificationsPerManager: 300,
    },
    concentrated: {
      count: 1,
      admins: 2,
      sellers: 12,
      sections: 12,
      products: 300,
      sales: 8000,
      notificationsPerManager: 600,
    },
    historyDays: 90,
  },
  large: {
    standard: {
      count: 10,
      admins: 1,
      sellers: 4,
      sections: 15,
      products: 600,
      sales: 8000,
      notificationsPerManager: 1000,
    },
    concentrated: {
      count: 1,
      admins: 2,
      sellers: 20,
      sections: 25,
      products: 1500,
      sales: 30000,
      notificationsPerManager: 2000,
    },
    historyDays: 180,
  },
});

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * 1-20B — `dist` de l'API mesurée : `LOAD_DIST` (dossier SOUS `api/`, par
 * exemple un témoin de l'ancien code), sinon `api/dist`.
 */
function distDir() {
  const value = process.env.LOAD_DIST;
  if (!value) return R.DIST;
  const full = path.resolve(value);
  if (!full.startsWith(R.API_DIR + path.sep)) {
    throw new Error('LOAD_DIST doit désigner un dossier sous api/.');
  }
  return full;
}

function dist(relative) {
  return require(path.join(distDir(), relative));
}

/** Refus par défaut de toute cible HTTP/Socket.IO non locale. */
function assertLocalTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Charge refusée : URL cible illisible.');
  }
  if (!['http:', 'ws:'].includes(parsed.protocol)) {
    throw new Error('Charge refusée : protocole cible inattendu.');
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(`Charge refusée : hôte non local (${parsed.hostname}).`);
  }
  if (Number(parsed.port) !== PORTS.api) {
    throw new Error(`Charge refusée : port ${parsed.port} ≠ ${PORTS.api}.`);
  }
  return url;
}

/** Refus de toute base autre que l'instance éphémère dédiée. */
function assertLoadUri(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error('Charge refusée : URI MongoDB absente ou illisible.');
  }
  if (parsed.protocol !== 'mongodb:')
    throw new Error('Charge refusée : protocole MongoDB inattendu.');
  if (parsed.username || parsed.password)
    throw new Error('Charge refusée : URI avec identifiants.');
  if (!LOCAL_HOSTS.has(parsed.hostname))
    throw new Error('Charge refusée : hôte MongoDB non local.');
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port === 27017)
    throw new Error('Charge refusée : port MongoDB 27017 ou invalide.');
  if (parsed.pathname !== `/${DB_NAME}`)
    throw new Error(`Charge refusée : base autre que ${DB_NAME}.`);
  return uri;
}

/** Environnement de l'API, des migrations et du peuplement. */
function apiEnv(uri, extra = {}) {
  return R.baseEnv({
    MONGODB_URI: assertLoadUri(uri),
    JWT_SECRET,
    CORS_ORIGIN: WEB_ORIGIN,
    NODE_ENV: 'production',
    TZ: 'Africa/Douala',
    PORT: String(PORTS.api),
    PUBLIC_REGISTRATION_ENABLED: 'false',
    PUBLIC_APP_URL: WEB_ORIGIN,
    S3_ENDPOINT: STORAGE_URL,
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: 'load-fictitious',
    S3_SECRET_KEY: 'load-fictitious',
    S3_BUCKET: STORAGE_BUCKET,
    S3_FORCE_PATH_STYLE: 'true',
    RESEND_API_KEY: '',
    EMAIL_FROM: '',
    LOAD_STATE_DIR: STATE_DIR,
    LOAD_DIST: process.env.LOAD_DIST || '',
    LOAD_DISPATCH_LANES: process.env.LOAD_DISPATCH_LANES || '',
    LOAD_KEEPALIVE_MS: process.env.LOAD_KEEPALIVE_MS || '',
    // 1-20F : rayon supplémentaire de N produits (entreprise concentrée).
    LOAD_BIG_SECTION: process.env.LOAD_BIG_SECTION || '',
    RECIPE_ENV_GUARD_LOG: path.join(STATE_DIR, 'env-guard.jsonl'),
    ...extra,
  });
}

function readJson(file) {
  try {
    return JSON.parse(require('fs').readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** État d'une stack de charge DÉMARRÉE (lanceur vivant). */
function requireRunningState() {
  const state = readJson(STATE_FILE);
  if (!state || !R.isAlive(state.launcherPid)) {
    throw new Error(
      'Aucune stack de charge en cours : node api/test/load/load-stack.js start',
    );
  }
  assertLoadUri(state.mongodbUri);
  assertLocalTarget(state.apiUrl);
  return state;
}

async function control(pathname, body) {
  const response = await fetch(`${CONTROL_URL}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(`Contrôle ${pathname} : HTTP ${response.status}`);
  return json;
}

/** Appel HTTP local (préparation, intégrité, concurrence). */
async function api(method, url, { token, body } = {}) {
  const target = assertLocalTarget(`${API_URL}${url}`);
  const started = performance.now();
  const response = await fetch(target, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // corps non JSON (204…)
  }
  return {
    status: response.status,
    body: json,
    ms: performance.now() - started,
  };
}

module.exports = {
  R,
  HOST,
  PORTS,
  API_URL,
  CONTROL_URL,
  STORAGE_URL,
  STORAGE_BUCKET,
  DB_NAME,
  PASSWORD,
  WEB_ORIGIN,
  STATE_DIR,
  STATE_FILE,
  SESSIONS_FILE,
  LOG_DIR,
  WORK_DIR,
  METRICS_API,
  METRICS_DB,
  METRICS_PROC,
  PUSH_FILE,
  MAIL_FILE,
  PHASE_FILE,
  LIMITS,
  PROFILES,
  distDir,
  dist,
  assertLocalTarget,
  assertLoadUri,
  apiEnv,
  readJson,
  requireRunningState,
  control,
  api,
};
