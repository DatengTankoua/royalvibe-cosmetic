/**
 * 1-14D.2H — Aides de la campagne navigateur (TEST), reprises de l'outillage
 * temporaire de 1-14D.2C (`pw14d2c/lib.js`) et adaptées à la stack de la
 * recette (127.0.0.1, simulateurs du lanceur, base de `state.json`).
 *
 * Playwright n'est PAS une dépendance du dépôt : il est chargé depuis une
 * installation EXISTANTE (`RECIPE_PLAYWRIGHT_DIR`), jamais installé ici.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const C = require('./recipe-common');
const D = require('./db-tools');
const A = require('./actions');

/** Playwright existant et son Chromium, sinon `null` (campagne non exécutée). */
function loadPlaywright() {
  const dir = process.env.RECIPE_PLAYWRIGHT_DIR;
  if (!dir) return { error: 'RECIPE_PLAYWRIGHT_DIR absent' };
  let modulePath;
  try {
    modulePath = require.resolve('playwright', { paths: [dir] });
  } catch {
    return { error: `playwright introuvable sous ${dir}` };
  }
  const playwright = require(modulePath);
  const version = require(
    require.resolve('playwright/package.json', { paths: [dir] }),
  ).version;
  // Chromium explicite (`--chromium=`) : une révision existante différente de
  // celle attendue par cette version de Playwright (cas de 1-14D.2C).
  const executable =
    process.env.RECIPE_CHROMIUM || playwright.chromium.executablePath();
  if (!executable || !fs.existsSync(executable)) {
    return {
      error: `Chromium absent (${executable}) ; préciser --chromium=<chrome.exe existant>`,
    };
  }
  return { playwright, version, executable, modulePath };
}

let connection;
let state;
function recipeState() {
  if (!state) state = C.requireRunningState();
  return state;
}
async function db() {
  if (!connection) connection = await D.connect(recipeState().mongodbUri);
  return connection.db;
}

const http = (method, url, options) => C.api(method, url, options);

async function restartApi(provider = 'simulated') {
  await C.control('/api/restart', { provider });
  await C.control('/sim/reset', {});
}

async function expireOrg(orgId) {
  return D.expireOrganization(await db(), orgId);
}

async function seedProduct(ownerToken, orgId, qty = 10) {
  const section = await http('POST', '/sections', {
    token: ownerToken,
    body: { name: `Rayon ${Date.now()}` },
  });
  if (section.status !== 201) throw new Error(`section ${section.status}`);
  const now = new Date();
  const res = await (await db()).collection('products').insertOne({
    sectionId: D.oid(section.body._id),
    name: `Produit ${Date.now()}`,
    imageUrl: 'https://e2e.local/p.png',
    purchasePrice: 100,
    salePrice: 400,
    initialQuantity: qty,
    remainingQuantity: qty,
    organizationId: D.oid(orgId),
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return { productId: String(res.insertedId), sectionId: section.body._id };
}

async function uiLogin(page, email) {
  await page.goto(`${C.WEB_ORIGIN}/auth/login`);
  await page.fill('#email', email);
  await page.fill('#password', C.PASSWORD);
  await page.click('button[type=submit]');
}

/** Opérations outbox de l'origine (lecture IDB brute, dans la page). */
async function outboxOps(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('stockmaster-offline-sales-outbox');
        req.onsuccess = () => {
          const dbx = req.result;
          if (!dbx.objectStoreNames.contains('operations'))
            return resolve({ ops: [], metas: [] });
          const tx = dbx.transaction(['operations', 'meta'], 'readonly');
          const ops = tx.objectStore('operations').getAll();
          const metas = tx.objectStore('meta').getAll();
          tx.oncomplete = () =>
            resolve({ ops: ops.result, metas: metas.result });
        };
        req.onerror = () => resolve(null);
      }),
  );
}

const sim = {
  stats: () => C.control('/sim/stats'),
  queueInit: (...behaviors) => C.control('/sim/queue-init', { behaviors }),
  queueStatus: (...behaviors) => C.control('/sim/queue-status', { behaviors }),
  settle: (reference, stateName) =>
    C.control('/sim/settle', { reference, state: stateName }),
};

function outputDir() {
  const dir = process.env.RECIPE_RESULTS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  C,
  D,
  A,
  WEB: C.WEB_ORIGIN,
  API: C.API_URL,
  PHONE: C.PHONE,
  loadPlaywright,
  recipeState,
  db,
  oid: D.oid,
  http,
  restartApi,
  registerOwner: A.registerOwner,
  inviteMember: A.inviteMember,
  expireOrg,
  seedProduct,
  uiLogin,
  outboxOps,
  sim,
  outputDir,
  path,
  close: async () => connection && connection.close(),
};
