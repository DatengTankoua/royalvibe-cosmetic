/**
 * 1-14D.2H — Constantes et aides communes de la recette locale (TEST).
 *
 * Tout est FICTIF : secrets, clé webhook, identifiants CamPay, comptes.
 * Aucune valeur n'est lue depuis un `.env` (garde `env-guard.cjs`) ni
 * depuis l'environnement de l'utilisateur : les environnements des
 * processus enfants sont construits ici, variable par variable.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '../../..');
const API_DIR = path.join(REPO, 'api');
const WEB_DIR = path.join(REPO, 'web');
const DIST = path.join(API_DIR, 'dist');
const PRELOAD = path.join(__dirname, 'preload.cjs');

const HOST = '127.0.0.1';
// 1-15C : `storage` = stockage objet simulé de la recette (`storage-sim.js`).
const PORTS = Object.freeze({
  web: 3200,
  api: 4200,
  control: 4299,
  storage: 4298,
});
const WEB_ORIGIN = `http://${HOST}:${PORTS.web}`;
const API_URL = `http://${HOST}:${PORTS.api}`;
const CONTROL_URL = `http://${HOST}:${PORTS.control}`;
const STORAGE_URL = `http://${HOST}:${PORTS.storage}`;

const DB_NAME = 'stockmaster_recipe';
const MONGODB_BINARY_VERSION = '8.2.6';

/** Valeurs FICTIVES, propres à la recette (jamais des secrets réels). */
const FAKE = Object.freeze({
  jwtSecret: 'recipe-14d2h-fictitious-login-jwt-secret',
  webhookKey: 'recipe-14d2h-fictitious-campay-webhook-key',
  campayUsername: 'recipe-fictitious-campay-app-username',
  campayPassword: 'recipe-fictitious-campay-app-password',
  campayToken: 'recipe.fictitious.campay.token',
  // 1-21B : faux SasPay (préfixe de bac à sable, valeurs fictives).
  saspayKey: 'sk_test_fake-recipe-saspay-0001',
  saspayWebhookSecret: 'recipe-21b-fictitious-saspay-webhook-secret',
});

const PASSWORD = 'Recette-locale-14d2h!';
const PHONE = '677123456';
const PROVIDERS = Object.freeze(['simulated', 'campay', 'saspay']);

/** Répertoire d'état de la recette en cours (un seul lanceur à la fois). */
const STATE_DIR = path.join(os.tmpdir(), 'stockmaster-recipe-14d2h');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const MAIL_FILE = path.join(STATE_DIR, 'mail.jsonl');
const GUARD_LOG = path.join(STATE_DIR, 'env-guard.jsonl');
const LOG_DIR = path.join(STATE_DIR, 'logs');
const WORK_DIR = path.join(STATE_DIR, 'cwd');
/**
 * Copie web isolée (build et serveur). Sous la racine du dépôt (Turbopack
 * refuse une jonction `node_modules` hors de sa racine) et NON ignorée par
 * Git (Tailwind exclut de son analyse les chemins ignorés). Supprimée au
 * nettoyage.
 */
const WEB_COPY_DIR = path.join(REPO, '.stockmaster-recipe-web');

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Garde d'isolation : l'URI doit être celle d'une instance éphémère locale
 * de la recette (adresse locale, port ≠ 27017, base `stockmaster_recipe`,
 * sans identifiants). Message sans l'URI complète.
 */
function assertRecipeUri(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error('Recette refusée : URI MongoDB absente ou illisible.');
  }
  if (parsed.protocol !== 'mongodb:') {
    throw new Error('Recette refusée : protocole MongoDB inattendu.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Recette refusée : URI avec identifiants.');
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error('Recette refusée : hôte MongoDB non local.');
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port === 27017) {
    throw new Error('Recette refusée : port MongoDB 27017 ou invalide.');
  }
  if (parsed.pathname !== `/${DB_NAME}`) {
    throw new Error(`Recette refusée : base autre que ${DB_NAME}.`);
  }
  return uri;
}

/** Variables système strictement nécessaires (aucune variable applicative). */
const SYSTEM_VARIABLES = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'LOCALAPPDATA',
  'APPDATA',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'LANG',
];

function nodeOptions() {
  return `--require ${JSON.stringify(PRELOAD.replace(/\\/g, '/'))}`;
}

/** Environnement de base de TOUT processus enfant de la recette. */
function baseEnv(extra = {}) {
  const env = {};
  for (const name of SYSTEM_VARIABLES) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return {
    ...env,
    NODE_OPTIONS: nodeOptions(),
    RECIPE_ENV_GUARD_LOG: GUARD_LOG,
    RECIPE_PARENT_PID: String(process.pid),
    ...extra,
  };
}

/**
 * 1-18C : anti-robot SIMULÉ sur demande explicite (`start --anti-bot=simulated`).
 * La simulation est TOUJOURS refusée avec `NODE_ENV=production` : l'API de
 * recette tourne alors en `development` (origines 127.0.0.1). Par défaut :
 * production, aucun anti-robot (inscription HTTP refusée, 503).
 */
const simulatedAntiBot = () => process.env.RECIPE_ANTI_BOT === 'simulated';

/** Environnement de l'API, des migrations, des fixtures et des CLI. */
function apiEnv(uri, extra = {}) {
  return baseEnv({
    MONGODB_URI: assertRecipeUri(uri),
    JWT_SECRET: FAKE.jwtSecret,
    CORS_ORIGIN: WEB_ORIGIN,
    NODE_ENV: simulatedAntiBot() ? 'development' : 'production',
    PORT: String(PORTS.api),
    PUBLIC_REGISTRATION_ENABLED: 'true',
    PUBLIC_APP_URL: WEB_ORIGIN,
    // 1-15C : stockage objet SIMULÉ de la recette (`storage-sim.js`, en
    // mémoire, 127.0.0.1) : vrai client et vraies validations côté API.
    S3_ENDPOINT: STORAGE_URL,
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: 'recipe-fictitious',
    S3_SECRET_KEY: 'recipe-fictitious',
    S3_BUCKET: 'recipe-fictitious',
    S3_FORCE_PATH_STYLE: 'true',
    // R2 privé : durée des URL signées ; `RECIPE_SIGNED_URL_TTL_SECONDS`
    // (60–3600) raccourcit la durée pour éprouver l'expiration.
    S3_SIGNED_URL_TTL_SECONDS: process.env.RECIPE_SIGNED_URL_TTL_SECONDS || '',
    // 1-17A (Compose/MinIO) : origine de signature distincte, jointe par le
    // navigateur via un relais (`RECIPE_S3_SIGNING_ENDPOINT`) ; vide = unique.
    S3_SIGNING_ENDPOINT: process.env.RECIPE_S3_SIGNING_ENDPOINT || '',
    // 1-17B : quota de stockage réduit pour éprouver le dépassement
    // (`RECIPE_STORAGE_QUOTA_BYTES`) ; vide = défaut serveur (250 Mo).
    STORAGE_QUOTA_BYTES: process.env.RECIPE_STORAGE_QUOTA_BYTES || '',
    RESEND_API_KEY: '',
    EMAIL_FROM: '',
    // 1-18C : anti-robot SIMULÉ (aucun réseau), seulement sur demande.
    ...(simulatedAntiBot() ? { TURNSTILE_SIMULATED: 'true' } : {}),
    ...extra,
  });
}

/**
 * Environnement du build et du serveur web. `__NEXT_PROCESSED_ENV` indique
 * à `@next/env` que l'environnement est déjà complet : même sans la garde,
 * aucune valeur d'un `.env*` ne serait appliquée.
 */
function webEnv(extra = {}) {
  return baseEnv({
    NODE_ENV: 'production',
    NEXT_PUBLIC_API_URL: API_URL,
    NEXT_PUBLIC_REGISTRATION_ENABLED: 'true',
    // 1-18C : case anti-robot locale (même simulation que l'API).
    ...(simulatedAntiBot() ? { NEXT_PUBLIC_TURNSTILE_SIMULATED: 'true' } : {}),
    NEXT_TELEMETRY_DISABLED: '1',
    __NEXT_PROCESSED_ENV: 'true',
    ...extra,
  });
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** État d'une recette DÉMARRÉE (lanceur vivant), sinon erreur explicite. */
function requireRunningState() {
  const state = readState();
  if (!state || !isAlive(state.launcherPid)) {
    throw new Error(
      'Aucune recette en cours. Démarrer : node api/test/recipe/recipe.js start',
    );
  }
  assertRecipeUri(state.mongodbUri);
  return state;
}

async function control(pathname, body) {
  const response = await fetch(`${CONTROL_URL}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `Contrôle ${pathname} : HTTP ${response.status} ${JSON.stringify(json)}`,
    );
  }
  return json;
}

async function api(method, url, { token, body, headers } = {}) {
  const response = await fetch(`${API_URL}${url}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(headers || {}),
    },
    body:
      body === undefined
        ? undefined
        : typeof body === 'string'
          ? body
          : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // corps non JSON
  }
  return {
    status: response.status,
    body: json,
    text,
    headers: response.headers,
  };
}

/** Résolution d'un module installé pour l'API (aucune installation). */
function apiRequire(name) {
  return require(require.resolve(name, { paths: [API_DIR] }));
}

function dist(relative) {
  return require(path.join(DIST, relative));
}

module.exports = {
  REPO,
  API_DIR,
  WEB_DIR,
  DIST,
  PRELOAD,
  HOST,
  PORTS,
  WEB_ORIGIN,
  API_URL,
  CONTROL_URL,
  STORAGE_URL,
  DB_NAME,
  MONGODB_BINARY_VERSION,
  FAKE,
  PASSWORD,
  PHONE,
  PROVIDERS,
  STATE_DIR,
  STATE_FILE,
  MAIL_FILE,
  GUARD_LOG,
  LOG_DIR,
  WORK_DIR,
  WEB_COPY_DIR,
  assertRecipeUri,
  baseEnv,
  apiEnv,
  webEnv,
  readState,
  isAlive,
  requireRunningState,
  control,
  api,
  apiRequire,
  dist,
};
