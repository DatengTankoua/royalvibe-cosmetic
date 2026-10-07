// 1-16F — Contrastes des couleurs du commerce dans les deux thèmes.
//
// Exécution : `node scripts/test-tenant-brand.mjs` depuis `web/`. Même
// principe que test-refresh-coordinator.mjs : runner `node:test`, module
// transpilé en mémoire par le TypeScript déjà installé, aucune dépendance.
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
  path.join(here, "..", "src", "lib", "tenant-brand.ts"),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
});
const loaded = { exports: {} };
new Function("module", "exports", "require", outputText)(
  loaded,
  loaded.exports,
  require,
);
const {
  computeTenantAccent,
  tenantAccentStyle,
  contrastRatio,
  DARK_BACKGROUND,
  DARK_SURFACE,
  DARK_MUTED,
} = loaded.exports;

const WHITE = "#ffffff";
const LIGHT_MUTED = "#f5f5f5"; // --muted oklch(0.97)

// Couleurs extrêmes : très claires, très sombres, saturées, moyennes.
const SAMPLES = [
  "#ffffff",
  "#fefefe",
  "#fff59d",
  "#ffd400",
  "#00ffff",
  "#7fff00",
  "#000000",
  "#062b5c",
  "#1a0033",
  "#0b3d0b",
  "#ff0000",
  "#00ff00",
  "#0000ff",
  "#ff00ff",
  "#ff6a00",
  "#808080",
  "#777777",
  "#3b82f6",
  "#e11d48",
];

for (const color of SAMPLES) {
  test(`couleur ${color} : variante claire lisible`, () => {
    const t = computeTenantAccent(color);
    assert.equal(t.brand, color, "couleur enregistrée conservée");
    assert.ok(
      contrastRatio(t.accent, t.accentForeground) >= 4.5,
      "texte sur bouton",
    );
    assert.ok(
      contrastRatio(t.accent, WHITE) >= 3,
      "bouton/barre contre fond blanc",
    );
    assert.ok(
      contrastRatio(t.accentInk, WHITE) >= 4.5,
      "texte accentué sur blanc",
    );
    assert.ok(
      contrastRatio(t.accentInk, t.accentSoft) >= 4.5,
      "texte accentué sur fond léger",
    );
    assert.ok(contrastRatio(t.accentRing, LIGHT_MUTED) >= 3, "focus");
  });

  test(`couleur ${color} : variante sombre lisible`, () => {
    const d = computeTenantAccent(color).dark;
    assert.ok(
      contrastRatio(d.accent, d.accentForeground) >= 4.5,
      "texte sur bouton",
    );
    assert.ok(
      contrastRatio(d.accent, DARK_SURFACE) >= 3,
      "bouton/barre contre carte sombre",
    );
    assert.ok(
      contrastRatio(d.accent, DARK_BACKGROUND) >= 3,
      "bouton/barre contre fond sombre",
    );
    for (const bg of [
      DARK_BACKGROUND,
      DARK_SURFACE,
      DARK_MUTED,
      d.accentSoft,
    ]) {
      assert.ok(
        contrastRatio(d.accentInk, bg) >= 4.5,
        `texte accentué sur ${bg}`,
      );
      assert.ok(contrastRatio(d.accentRing, bg) >= 3, `focus sur ${bg}`);
    }
    assert.ok(
      contrastRatio(d.accentBorder, DARK_BACKGROUND) >= 1.5,
      "filet perceptible",
    );
  });
}

test("couleur invalide : repli navy Stock Master", () => {
  assert.equal(computeTenantAccent("red").brand, "#062b5c");
  assert.equal(computeTenantAccent("#abc").brand, "#062b5c");
  assert.equal(computeTenantAccent(undefined).brand, "#062b5c");
});

test("navy par défaut : variante claire inchangée par rapport à 1-12A", () => {
  const t = computeTenantAccent("#062b5c");
  assert.equal(t.accent, "#062b5c");
  assert.equal(t.accentForeground, "#ffffff");
  assert.equal(t.accentInk, "#062b5c");
});

test("style : uniquement des #rrggbb, deux variantes", () => {
  const style = tenantAccentStyle(computeTenantAccent("#ff6a00"));
  const keys = Object.keys(style);
  assert.ok(keys.includes("--tenant-light-accent"));
  assert.ok(keys.includes("--tenant-dark-accent-ink"));
  for (const value of Object.values(style)) {
    assert.match(value, /^#[0-9a-f]{6}$/);
  }
});
