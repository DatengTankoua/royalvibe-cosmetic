// 1-20F — Tests déterministes de la pagination des produits côté web :
// règle de recherche (`product-search.ts`), cache hors ligne alimenté par
// des pages (`offline-catalog-db.ts`, fonctions pures) et synchronisation
// complète distincte, bornée et reprenable (`offline-section-sync.ts`),
// avec le stock indicatif des ventes locales (`offline-sales-policy.ts`).
//
// Exécution : `pnpm --filter web test:products-pagination` (ou `node
// scripts/test-products-pagination.mjs` depuis `web/`). Aucune dépendance
// ajoutée : runner `node:test`, modules transpilés en mémoire.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const nodeRequire = createRequire(import.meta.url);
const ts = nodeRequire("typescript");
const cache = new Map();
// Modules d'accès au navigateur (IndexedDB) : jamais appelés ici.
const stubs = { "./offline-db-utils": {} };

function load(file) {
  if (cache.has(file)) return cache.get(file);
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
  cache.set(file, loaded.exports);
  const localRequire = (name) => {
    if (name in stubs) return stubs[name];
    if (name.startsWith("./")) return load(`${name.slice(2)}.ts`);
    throw new Error(`module non prévu : ${name}`);
  };
  new Function("module", "exports", "require", outputText)(
    loaded,
    loaded.exports,
    localRequire,
  );
  return loaded.exports;
}

const { isProductSearch, matchesProductSearch } = load("product-search.ts");
const {
  applyScopeUpdatesToSnapshot,
  snapshotProductLoadedAt,
  OFFLINE_CATALOG_SCHEMA_VERSION,
  isSnapshotUsable,
} = load("offline-catalog-db.ts");
const {
  runSectionSync,
  needsSectionSync,
  sectionProductsScope,
  OFFLINE_SYNC_MAX_PAGES,
  OFFLINE_SYNC_INTERVAL_MS,
  OFFLINE_SYNC_RESUME_MS,
} = load("offline-section-sync.ts");
const { reservesStock } = load("offline-sales-policy.ts");

const S = "s1";
const p = (id, remainingQuantity = 10, sectionId = S, extra = {}) => ({
  _id: id,
  sectionId,
  name: `Produit ${id}`,
  salePrice: 1000,
  remainingQuantity,
  status: "in_stock",
  ...extra,
});
const empty = () => ({
  schemaVersion: OFFLINE_CATALOG_SCHEMA_VERSION,
  userId: "u",
  organizationId: "o",
  updatedAt: new Date(0).toISOString(),
  sections: [],
  products: [],
  syncedScopes: [],
});
const at = (ids, t) => Object.fromEntries(ids.map((id) => [id, t]));
const ids = (snap) => snap.products.map((x) => x._id).sort();
const KEY = sectionProductsScope(S);

test("recherche : même règle qu'avant (contient, casse ignorée, accents distingués)", () => {
  assert.equal(isProductSearch("   "), false);
  assert.equal(matchesProductSearch("Éclair au café", "éCLAIR"), true);
  assert.equal(matchesProductSearch("Éclair au café", "eclair"), false);
  assert.equal(matchesProductSearch("Prix a.b", ".b"), true);
  assert.equal(matchesProductSearch("Prix axb", "a.b"), false);
  assert.equal(matchesProductSearch("Crème double", " double"), true);
  assert.equal(matchesProductSearch("Double", " double"), false);
  assert.equal(matchesProductSearch("Tout", "  "), true);
});

test("page : met à jour ses produits, ne supprime jamais les absents, ne marque pas le rayon synchronisé", () => {
  let snap = applyScopeUpdatesToSnapshot(
    empty(),
    [
      {
        kind: "section-products",
        sectionId: S,
        products: [p("a"), p("b"), p("c")],
        loadedAt: at(["a", "b", "c"], 100),
        readStartedAt: 100,
      },
    ],
    100,
  );
  assert.deepEqual(snap.syncedScopes, [KEY]);
  // Page 1 relue : seuls a et b, b vendu ; c (page 2) conservé.
  snap = applyScopeUpdatesToSnapshot(
    snap,
    [
      {
        kind: "products-upsert",
        products: [p("a"), p("b", 7)],
        loadedAt: at(["a", "b"], 200),
      },
    ],
    200,
  );
  assert.deepEqual(ids(snap), ["a", "b", "c"]);
  assert.equal(snap.products.find((x) => x._id === "b").remainingQuantity, 7);
  assert.equal(snapshotProductLoadedAt(snap, "b"), 200);
  assert.equal(snapshotProductLoadedAt(snap, "c"), 100);
  // Rayon jamais synchronisé : une page ne le marque pas.
  const partial = applyScopeUpdatesToSnapshot(
    empty(),
    [
      {
        kind: "products-upsert",
        products: [p("x", 1, "s2")],
        loadedAt: at(["x"], 5),
      },
    ],
    5,
  );
  assert.deepEqual(partial.syncedScopes, []);
  assert.deepEqual(ids(partial), ["x"]);
});

test("page plus ancienne qu'une lecture déjà enregistrée : ignorée", () => {
  let snap = applyScopeUpdatesToSnapshot(
    empty(),
    [
      {
        kind: "products-upsert",
        products: [p("a", 5)],
        loadedAt: at(["a"], 300),
      },
    ],
    300,
  );
  snap = applyScopeUpdatesToSnapshot(
    snap,
    [
      {
        kind: "products-upsert",
        products: [p("a", 9)],
        loadedAt: at(["a"], 250),
      },
    ],
    310,
  );
  assert.equal(snap.products[0].remainingQuantity, 5);
  assert.equal(snapshotProductLoadedAt(snap, "a"), 300);
});

test("réponse complète : remplace le rayon, sauf les produits relus après son début", () => {
  let snap = applyScopeUpdatesToSnapshot(
    empty(),
    [
      {
        kind: "section-products",
        sectionId: S,
        products: [p("a"), p("old")],
        loadedAt: at(["a", "old"], 10),
        readStartedAt: 10,
      },
    ],
    10,
  );
  // Pendant la synchronisation (commencée à 100) : « new » créé et affiché
  // (lu à 150), « a » revendu (lu à 160).
  snap = applyScopeUpdatesToSnapshot(
    snap,
    [
      {
        kind: "products-upsert",
        products: [p("new"), p("a", 3)],
        loadedAt: { new: 150, a: 160 },
      },
    ],
    160,
  );
  snap = applyScopeUpdatesToSnapshot(
    snap,
    [
      {
        kind: "section-products",
        sectionId: S,
        products: [p("a", 8), p("b")],
        loadedAt: { a: 100, b: 120 },
        readStartedAt: 100,
      },
    ],
    200,
  );
  // « old » supprimé (absent, lu avant), « new » conservé, « a » plus récent conservé.
  assert.deepEqual(ids(snap), ["a", "b", "new"]);
  assert.equal(snap.products.find((x) => x._id === "a").remainingQuantity, 3);
  assert.equal(snapshotProductLoadedAt(snap, "a"), 160);
  assert.equal(
    snapshotProductLoadedAt(snap, "old"),
    Date.parse(snap.updatedAt),
  );
  assert.ok(!("old" in snap.productLoadedAt));
  assert.equal(snap.scopeSyncedAt[KEY], 200);
});

test("réponse complète sans dates (appel antérieur) : remplacement intégral, comme avant", () => {
  let snap = applyScopeUpdatesToSnapshot(
    empty(),
    [
      {
        kind: "products-upsert",
        products: [p("a"), p("z")],
        loadedAt: at(["a", "z"], 500),
      },
    ],
    500,
  );
  snap = applyScopeUpdatesToSnapshot(
    snap,
    [{ kind: "section-products", sectionId: S, products: [p("a", 1)] }],
    600,
  );
  assert.deepEqual(ids(snap), ["a"]);
  assert.equal(snap.products[0].remainingQuantity, 1);
});

test("corbeille, purge, déplacement : retirés ; déjà rangé dans le nouveau rayon : conservé", () => {
  let snap = applyScopeUpdatesToSnapshot(
    empty(),
    [
      {
        kind: "products-upsert",
        products: [p("a"), p("b"), p("m", 1, "s2")],
        loadedAt: at(["a", "b", "m"], 1),
      },
    ],
    1,
  );
  snap = applyScopeUpdatesToSnapshot(
    snap,
    [{ kind: "products-remove", ids: ["a"] }],
    2,
  );
  snap = applyScopeUpdatesToSnapshot(
    snap,
    [{ kind: "products-remove", ids: ["b", "m"], keepInSectionId: "s2" }],
    3,
  );
  assert.deepEqual(ids(snap), ["m"]);
});

test("champs facultatifs : snapshot antérieur toujours utilisable, champs conservés à l'écriture", () => {
  const legacy = { ...empty(), updatedAt: new Date().toISOString() };
  assert.equal(isSnapshotUsable(legacy, "u", "o"), true);
  assert.equal(
    snapshotProductLoadedAt(legacy, "x"),
    Date.parse(legacy.updatedAt),
  );
  const next = applyScopeUpdatesToSnapshot(
    legacy,
    [
      {
        kind: "sync-progress",
        scope: KEY,
        pending: {
          startedAt: 1,
          updatedAt: 1,
          cursor: "c",
          pages: 1,
          products: [],
          loadedAt: {},
        },
      },
    ],
    Date.now(),
  );
  assert.equal(isSnapshotUsable(next, "u", "o"), true);
  assert.equal(next.pendingSyncs[KEY].cursor, "c");
  assert.deepEqual(next.syncedScopes, []);
});

/** API simulée : rayon de `n` produits, pages de `size`. */
function fakeApi(n, size, opts = {}) {
  const all = Array.from({ length: n }, (_, i) =>
    p(`p${String(i).padStart(4, "0")}`, 10),
  );
  const calls = [];
  return {
    calls,
    all,
    async fetchPage(cursor) {
      calls.push(cursor);
      if (opts.legacy) return { items: all, nextCursor: null, legacy: true };
      const start = cursor === null ? 0 : Number(cursor);
      const items = all.slice(start, start + size);
      const next = start + size < all.length ? String(start + size) : null;
      return { items, nextCursor: next, legacy: false };
    },
  };
}

function memoryStore(initial = null) {
  let snap = initial;
  let clock = 1_000_000;
  return {
    now: () => clock,
    tick: (ms) => {
      clock += ms;
    },
    get: () => snap,
    readSnapshot: async () => snap,
    apply: async (updates) => {
      snap = applyScopeUpdatesToSnapshot(snap ?? empty(), updates, clock);
      return true;
    },
  };
}

test("synchronisation : rayon complet en pages séquentielles, puis plus rien avant l'intervalle", async () => {
  const api = fakeApi(250, 100);
  const store = memoryStore();
  const run = () =>
    runSectionSync({
      sectionId: S,
      readSnapshot: store.readSnapshot,
      fetchPage: api.fetchPage,
      apply: store.apply,
      shouldContinue: () => true,
      now: store.now,
    });
  assert.equal(await run(), "complete");
  assert.deepEqual(api.calls, [null, "100", "200"]);
  assert.equal(store.get().products.length, 250);
  assert.ok(store.get().syncedScopes.includes(KEY));
  assert.equal(store.get().pendingSyncs[KEY], undefined);
  // Ouverture suivante dans l'intervalle : aucune requête.
  store.tick(60_000);
  assert.equal(await run(), "not-needed");
  assert.equal(api.calls.length, 3);
  store.tick(OFFLINE_SYNC_INTERVAL_MS);
  assert.equal(needsSectionSync(store.get(), S, store.now()), true);
});

test("synchronisation interrompue (rayon quitté) puis REPRISE au curseur enregistré", async () => {
  const api = fakeApi(250, 100);
  const store = memoryStore();
  let allowed = 1;
  const outcome = await runSectionSync({
    sectionId: S,
    readSnapshot: store.readSnapshot,
    fetchPage: api.fetchPage,
    apply: store.apply,
    shouldContinue: () => allowed-- > 0,
    now: store.now,
  });
  assert.equal(outcome, "paused");
  assert.equal(store.get().pendingSyncs[KEY].cursor, "100");
  assert.ok(!store.get().syncedScopes.includes(KEY));
  // Aucun produit de la synchronisation n'est publié avant la fin.
  assert.equal(store.get().products.length, 0);
  store.tick(60_000);
  assert.equal(
    await runSectionSync({
      sectionId: S,
      readSnapshot: store.readSnapshot,
      fetchPage: api.fetchPage,
      apply: store.apply,
      shouldContinue: () => true,
      now: store.now,
    }),
    "complete",
  );
  assert.deepEqual(api.calls, [null, "100", "200"]);
  assert.equal(store.get().products.length, 250);
  assert.equal(new Set(store.get().products.map((x) => x._id)).size, 250);
});

test("reprise trop ancienne : recommencée depuis le début", async () => {
  const api = fakeApi(250, 100);
  const store = memoryStore();
  let allowed = 1;
  await runSectionSync({
    sectionId: S,
    readSnapshot: store.readSnapshot,
    fetchPage: api.fetchPage,
    apply: store.apply,
    shouldContinue: () => allowed-- > 0,
    now: store.now,
  });
  store.tick(OFFLINE_SYNC_RESUME_MS + 1);
  await runSectionSync({
    sectionId: S,
    readSnapshot: store.readSnapshot,
    fetchPage: api.fetchPage,
    apply: store.apply,
    shouldContinue: () => true,
    now: store.now,
  });
  assert.deepEqual(api.calls, [null, null, "100", "200"]);
});

test("synchronisation bornée : au-delà du maximum, produits lus conservés, rayon NON synchronisé, aucun nouvel essai avant l'intervalle", async () => {
  const api = fakeApi(OFFLINE_SYNC_MAX_PAGES * 10 + 5, 10);
  const store = memoryStore();
  const run = () =>
    runSectionSync({
      sectionId: S,
      readSnapshot: store.readSnapshot,
      fetchPage: api.fetchPage,
      apply: store.apply,
      shouldContinue: () => true,
      now: store.now,
    });
  assert.equal(await run(), "truncated");
  assert.equal(api.calls.length, OFFLINE_SYNC_MAX_PAGES);
  assert.equal(store.get().products.length, OFFLINE_SYNC_MAX_PAGES * 10);
  assert.ok(!store.get().syncedScopes.includes(KEY));
  assert.equal(await run(), "not-needed");
  assert.equal(api.calls.length, OFFLINE_SYNC_MAX_PAGES);
});

test("API antérieure : la première réponse est le rayon complet", async () => {
  const api = fakeApi(130, 100, { legacy: true });
  const store = memoryStore();
  assert.equal(
    await runSectionSync({
      sectionId: S,
      readSnapshot: store.readSnapshot,
      fetchPage: api.fetchPage,
      apply: store.apply,
      shouldContinue: () => true,
      now: store.now,
    }),
    "complete",
  );
  assert.equal(api.calls.length, 1);
  assert.equal(store.get().products.length, 130);
});

test("ventes locales : ni comptées deux fois, ni oubliées, avec la date de lecture de CHAQUE page", async () => {
  const api = fakeApi(150, 100);
  const store = memoryStore();
  const fetchPage = async (cursor) => {
    const page = await api.fetchPage(cursor);
    store.tick(1000); // une seconde par page
    return page;
  };
  // Page 1 lue à t0, page 2 à t0+1 s. Vente locale de p0120 (page 2)
  // confirmée entre les deux lectures : incluse dans le stock de la page 2.
  const t0 = store.now();
  await runSectionSync({
    sectionId: S,
    readSnapshot: store.readSnapshot,
    fetchPage,
    apply: store.apply,
    shouldContinue: () => true,
    now: store.now,
  });
  const snap = store.get();
  const confirmed = {
    status: "synced",
    updatedAt: t0 + 500,
    payload: { productId: "p0120" },
  };
  assert.equal(snapshotProductLoadedAt(snap, "p0120"), t0 + 1000);
  assert.equal(
    reservesStock(confirmed, snapshotProductLoadedAt(snap, "p0120")),
    false,
  );
  // Même vente sur un produit de la page 1 (lue avant) : encore réservée.
  const onFirst = { ...confirmed, payload: { productId: "p0001" } };
  assert.equal(snapshotProductLoadedAt(snap, "p0001"), t0);
  assert.equal(
    reservesStock(onFirst, snapshotProductLoadedAt(snap, "p0001")),
    true,
  );
  // Vente en attente : toujours réservée.
  assert.equal(
    reservesStock(
      { status: "pending", updatedAt: t0, payload: { productId: "p0120" } },
      t0 + 1000,
    ),
    true,
  );
});
