// 1-15A — Tests déterministes de `src/lib/refresh-coordinator.ts`.
//
// Exécution : `pnpm --filter web test:coordinator` (ou `node
// scripts/test-refresh-coordinator.mjs` depuis `web/`). Aucune dépendance
// ajoutée : runner `node:test`, horloge simulée `mock.timers` (aucune attente
// réelle), module transpilé en mémoire par le TypeScript déjà installé.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require("typescript");

const source = readFileSync(
  path.join(here, "..", "src", "lib", "refresh-coordinator.ts"),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
});
const loaded = { exports: {} };
new Function("module", "exports", outputText)(loaded, loaded.exports);
const { createRefreshCoordinator, createResponseOrder } = loaded.exports;

/** Laisse s'exécuter les promesses en attente (aucun délai réel). */
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** Promesse contrôlée par le test (barrière). */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("regroupement : une rafale de demandes donne une seule relecture", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let runs = 0;
  const c = createRefreshCoordinator(async () => {
    runs += 1;
  }, 400);
  for (let i = 0; i < 10; i += 1) c.request();
  t.mock.timers.tick(399);
  await flush();
  assert.equal(runs, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(runs, 1);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(runs, 1);
});

test("fenêtre non repoussée : un flux continu ne retarde pas la relecture", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let runs = 0;
  const c = createRefreshCoordinator(async () => {
    runs += 1;
  }, 400);
  // Une demande toutes les 100 ms pendant 1 000 ms.
  for (let elapsed = 0; elapsed < 1000; elapsed += 100) {
    c.request();
    t.mock.timers.tick(100);
    await flush();
  }
  // Avec une fenêtre repoussée, aucune relecture n'aurait eu lieu.
  assert.ok(runs >= 2, `relectures pendant le flux : ${runs}`);
  c.dispose();
});

test("sérialisation : jamais deux relectures simultanées, demande pendant une relecture conservée", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gates = [];
  let active = 0;
  let maxActive = 0;
  const c = createRefreshCoordinator(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
    active -= 1;
  }, 400);
  c.request();
  t.mock.timers.tick(400);
  await flush();
  assert.equal(gates.length, 1);
  // Invalidations arrivées PENDANT la relecture.
  c.request();
  c.request();
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(gates.length, 1, "aucune relecture parallèle");
  gates[0].resolve();
  await flush();
  t.mock.timers.tick(400);
  await flush();
  assert.equal(gates.length, 2, "l'invalidation n'est pas perdue");
  gates[1].resolve();
  await flush();
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(gates.length, 2, "une seule relecture supplémentaire");
  assert.equal(maxActive, 1);
});

test("récupération après erreur : une relecture en échec ne bloque pas les suivantes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let runs = 0;
  const c = createRefreshCoordinator(async () => {
    runs += 1;
    if (runs === 1) throw new Error("réseau");
  }, 400);
  c.request();
  t.mock.timers.tick(400);
  await flush();
  assert.equal(runs, 1);
  c.request();
  t.mock.timers.tick(400);
  await flush();
  assert.equal(runs, 2);
});

test("destruction : aucune relecture après dispose, ni en attente ni nouvelle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let runs = 0;
  const c = createRefreshCoordinator(async () => {
    runs += 1;
  }, 400);
  c.request();
  c.dispose();
  t.mock.timers.tick(10_000);
  await flush();
  c.request();
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(runs, 0);
});

test("ordre des réponses : une réponse périmée n'écrase jamais une plus récente", () => {
  const order = createResponseOrder();
  const older = order.begin();
  const newer = order.begin();
  assert.equal(order.accept(newer), true);
  assert.equal(order.accept(older), false, "réponse périmée refusée");
  const first = order.begin();
  const second = order.begin();
  assert.equal(order.accept(first), true, "plus ancienne arrivée la première");
  assert.equal(order.accept(second), true);
});
