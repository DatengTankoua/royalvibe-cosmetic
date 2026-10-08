// R2 privé — Tests déterministes de `src/lib/image-renewal.ts` (bornes du
// renouvellement des liens d'image signés).
//
// Exécution : `pnpm --filter web test:image-renewal` (ou `node
// scripts/test-image-renewal.mjs` depuis `web/`). Aucune dépendance ajoutée :
// runner `node:test`, horloge passée explicitement, module transpilé en
// mémoire par le TypeScript déjà installé.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require("typescript");

const source = readFileSync(
  path.join(here, "..", "src", "lib", "image-renewal.ts"),
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
const {
  imageIdentity,
  registerImageRenewal,
  requestImageRenewal,
  resetImageRenewalForTests,
  IMAGE_RENEWAL_IDENTITY_MS,
  IMAGE_RENEWAL_MIN_INTERVAL_MS,
} = loaded.exports;

const A1 =
  "https://acc.eu.r2.cloudflarestorage.com/b/organizations/o/products/a.jpg?X-Amz-Signature=1";
const A2 =
  "https://acc.eu.r2.cloudflarestorage.com/b/organizations/o/products/a.jpg?X-Amz-Signature=2";
const B =
  "https://acc.eu.r2.cloudflarestorage.com/b/organizations/o/products/b.jpg?X-Amz-Signature=1";

beforeEach(() => resetImageRenewalForTests());

test("identité : lien sans sa signature (une relecture change la signature)", () => {
  assert.equal(imageIdentity(A1), imageIdentity(A2));
  assert.notEqual(imageIdentity(A1), imageIdentity(B));
});

test("un échec demande UNE relecture à chaque écran monté", () => {
  let a = 0;
  let b = 0;
  registerImageRenewal(() => a++);
  registerImageRenewal(() => b++);
  assert.equal(requestImageRenewal(A1, 1_000_000), true);
  assert.deepEqual([a, b], [1, 1]);
});

test("aucun écran monté : aucune demande", () => {
  assert.equal(requestImageRenewal(A1, 1_000_000), false);
});

test("même image (nouvelle signature) : pas de nouvelle demande avant le délai — fichier absent sans boucle", () => {
  let calls = 0;
  registerImageRenewal(() => calls++);
  const t0 = 1_000_000;
  assert.equal(requestImageRenewal(A1, t0), true);
  // Lien neuf toujours en échec (fichier absent) : borné.
  assert.equal(requestImageRenewal(A2, t0 + 60_000), false);
  assert.equal(
    requestImageRenewal(A2, t0 + IMAGE_RENEWAL_IDENTITY_MS - 1),
    false,
  );
  assert.equal(requestImageRenewal(A2, t0 + IMAGE_RENEWAL_IDENTITY_MS), true);
  assert.equal(calls, 2);
});

test("toutes images confondues : au plus une demande par intervalle minimal", () => {
  let calls = 0;
  registerImageRenewal(() => calls++);
  const t0 = 1_000_000;
  assert.equal(requestImageRenewal(A1, t0), true);
  assert.equal(requestImageRenewal(B, t0 + 1), false);
  assert.equal(
    requestImageRenewal(B, t0 + IMAGE_RENEWAL_MIN_INTERVAL_MS),
    true,
  );
  assert.equal(calls, 2);
});

test("désabonnement : un écran démonté n'est plus relu", () => {
  let calls = 0;
  const off = registerImageRenewal(() => calls++);
  off();
  assert.equal(requestImageRenewal(A1, 1_000_000), false);
  assert.equal(calls, 0);
});
