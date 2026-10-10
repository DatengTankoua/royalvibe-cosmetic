// 1-20D — Tests déterministes de `src/lib/catalog-refresh.ts` (relecture
// ciblée des produits après les ventes) et de son regroupement par
// `src/lib/refresh-coordinator.ts`.
//
// Exécution : `pnpm --filter web test:catalog-refresh` (ou `node
// scripts/test-catalog-refresh.mjs` depuis `web/`). Aucune dépendance
// ajoutée : runner `node:test`, modules transpilés en mémoire.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require("typescript");

function load(file) {
  const source = readFileSync(
    path.join(here, "..", "src", "lib", file),
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
  return loaded.exports;
}

const { createCatalogFreshness, planRefresh, TARGETED_REFRESH_MAX_IDS } =
  load("catalog-refresh.ts");
const { createRefreshCoordinator } = load("refresh-coordinator.ts");

const p = (id, remainingQuantity, extra = {}) => ({
  _id: id,
  remainingQuantity,
  ...extra,
});
const stock = (list) =>
  Object.fromEntries(list.map((x) => [x._id, x.remainingQuantity]));

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

test("ciblée : seul le produit vendu est remplacé par sa version serveur", () => {
  const f = createCatalogFreshness();
  const full = f.applyFull(f.begin(), [], [p("a", 10), p("b", 5)]);
  const t = f.begin();
  const { next, applied } = f.applyTargeted(t, full, ["a"], [p("a", 9)]);
  assert.deepEqual(stock(next), { a: 9, b: 5 });
  assert.deepEqual(applied, ["a"]);
  // L'objet non concerné est inchangé (aucun re-rendu inutile).
  assert.equal(next[1], full[1]);
});

test("ciblée : remplacement COMPLET (un champ retiré par la projection disparaît)", () => {
  const f = createCatalogFreshness();
  const full = f.applyFull(f.begin(), [], [p("a", 10, { totalRevenue: 500 })]);
  const { next } = f.applyTargeted(f.begin(), full, ["a"], [p("a", 9)]);
  assert.equal("totalRevenue" in next[0], false);
});

test("réponses désordonnées : une réponse ciblée plus ancienne n'écrase pas une plus récente", () => {
  const f = createCatalogFreshness();
  let list = f.applyFull(f.begin(), [], [p("a", 10)]);
  const older = f.begin(); // vente 1 relue…
  const newer = f.begin(); // …puis vente 2 relue, réponse arrivée d'abord
  list = f.applyTargeted(newer, list, ["a"], [p("a", 8)]).next;
  list = f.applyTargeted(older, list, ["a"], [p("a", 9)]).next;
  assert.deepEqual(stock(list), { a: 8 });
});

test("liste complète plus ancienne arrivée après une relecture ciblée : le produit relu est conservé", () => {
  const f = createCatalogFreshness();
  let list = f.applyFull(f.begin(), [], [p("a", 10), p("b", 5)]);
  const fullTicket = f.begin(); // relecture complète lente
  const targeted = f.begin();
  list = f.applyTargeted(targeted, list, ["a"], [p("a", 7)]).next;
  list = f.applyFull(fullTicket, list, [p("a", 10), p("b", 4)]);
  assert.deepEqual(stock(list), { a: 7, b: 4 });
});

test("liste complète plus récente : elle fait foi, y compris sur les produits relus avant", () => {
  const f = createCatalogFreshness();
  let list = f.applyFull(f.begin(), [], [p("a", 10)]);
  list = f.applyTargeted(f.begin(), list, ["a"], [p("a", 9)]).next;
  list = f.applyFull(f.begin(), list, [p("a", 6)]);
  assert.deepEqual(stock(list), { a: 6 });
});

test("liste complète périmée (une plus récente déjà appliquée) : ignorée", () => {
  const f = createCatalogFreshness();
  const t1 = f.begin();
  const t2 = f.begin();
  const list = f.applyFull(t2, [], [p("a", 6)]);
  assert.equal(f.applyFull(t1, list, [p("a", 10)]), null);
});

test("produit absent de la réponse ciblée (corbeille, autre rayon) : retiré, jamais réintroduit par une liste plus ancienne", () => {
  const f = createCatalogFreshness();
  let list = f.applyFull(f.begin(), [], [p("a", 10), p("b", 5)]);
  const oldFull = f.begin();
  list = f.applyTargeted(f.begin(), list, ["a"], []).next;
  assert.deepEqual(stock(list), { b: 5 });
  list = f.applyFull(oldFull, list, [p("a", 10), p("b", 5)]);
  assert.deepEqual(stock(list), { b: 5 });
});

test("ancienne API (liste complète renvoyée) : seuls les produits demandés sont appliqués, aucune insertion", () => {
  const f = createCatalogFreshness();
  let list = f.applyFull(f.begin(), [], [p("a", 10), p("b", 5)]);
  const { next, applied } = f.applyTargeted(
    f.begin(),
    list,
    ["a"],
    [p("a", 9), p("b", 1), p("z", 3)],
  );
  list = next;
  assert.deepEqual(stock(list), { a: 9, b: 5 });
  assert.deepEqual(applied, ["a"]);
});

test("produit retiré localement pendant la requête : jamais réinséré", () => {
  const f = createCatalogFreshness();
  const list = f.applyFull(f.begin(), [], [p("a", 10)]);
  const t = f.begin();
  const afterDelete = list.filter((x) => x._id !== "a");
  const { next, applied } = f.applyTargeted(t, afterDelete, ["a"], [p("a", 9)]);
  assert.deepEqual(next, []);
  assert.deepEqual(applied, []);
});

test("doublons : un même produit demandé deux fois n'est relu qu'une fois", () => {
  assert.deepEqual(planRefresh(["a", "a", "b"], false), {
    kind: "targeted",
    ids: ["a", "b"],
  });
});

test("plan : complète si demandée, si rien n'est désigné ou au-delà de la borne", () => {
  assert.deepEqual(planRefresh(["a"], true), { kind: "full" });
  assert.deepEqual(planRefresh([], false), { kind: "full" });
  const many = Array.from(
    { length: TARGETED_REFRESH_MAX_IDS + 1 },
    (_, i) => `p${i}`,
  );
  assert.deepEqual(planRefresh(many, false), { kind: "full" });
  assert.equal(
    planRefresh(many.slice(0, TARGETED_REFRESH_MAX_IDS), false).kind,
    "targeted",
  );
});

test("rafale de ventes (2/s pendant 5 s) : relectures regroupées, jamais repoussées, aucune complète", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = new Set();
  let full = false;
  const runs = [];
  const c = createRefreshCoordinator(async () => {
    const plan = planRefresh(pending, full);
    pending.clear();
    full = false;
    runs.push(plan);
  }, 400);
  for (let i = 0; i < 10; i += 1) {
    pending.add(`p${i % 3}`);
    c.request();
    t.mock.timers.tick(500);
    await flush();
  }
  t.mock.timers.tick(400);
  await flush();
  assert.ok(
    runs.length >= 9 && runs.length <= 10,
    `relectures : ${runs.length}`,
  );
  assert.ok(runs.every((r) => r.kind === "targeted"));
  // Chaque relecture part au plus 400 ms après la première demande.
  c.dispose();
});

test("rattrapage après reconnexion : complète même si des produits sont en attente", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = new Set(["a"]);
  let full = false;
  const runs = [];
  const c = createRefreshCoordinator(async () => {
    runs.push(planRefresh(pending, full));
    pending.clear();
    full = false;
  }, 400);
  // `onCatchUp` de useLiveRefresh, puis la demande de rattrapage.
  full = true;
  c.request();
  t.mock.timers.tick(400);
  await flush();
  assert.deepEqual(runs, [{ kind: "full" }]);
  c.dispose();
});
