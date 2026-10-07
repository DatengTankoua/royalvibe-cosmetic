#!/usr/bin/env node
// 1-16G — Contrôle des ressources de traduction FR/EN (relançable, CI).
//
// Charge `src/i18n/resources/{fr,en}/*.ts` (transpilés en mémoire par le
// compilateur TypeScript du projet) et vérifie, SANS aucun repli d'une
// langue sur l'autre :
//   1. mêmes namespaces et mêmes clés dans les deux langues (la forme
//      plurielle française `_many` n'a pas d'équivalent anglais) ;
//   2. aucune valeur vide, aucune valeur qui n'est pas du texte ;
//   3. mêmes variables `{{…}}` pour une même clé (pluriels comparés à la
//      forme `_other`) ;
//   4. mêmes balises de mise en forme `<nom>…</nom>` ;
//   5. pluriels complets : `_one`, `_many`, `_other` en français ;
//      `_one`, `_other` en anglais ;
//   6. rendu réel par i18next en anglais, avec `fallbackLng: false` : une
//      clé anglaise manquante apparaîtrait comme la clé brute, jamais
//      masquée par le français.
// Sortie 1 au premier problème relevé (liste complète affichée).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import i18next from "i18next";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESOURCES = path.join(ROOT, "src", "i18n", "resources");
const PLURAL = /_(zero|one|two|few|many|other)$/;

async function loadLocale(locale) {
  const dir = path.join(RESOURCES, locale);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `i18n-${locale}-`));
  const out = {};
  try {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      const { outputText } = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      });
      const js = path.join(tmp, file.replace(/\.ts$/, ".mjs"));
      fs.writeFileSync(js, outputText);
      out[file.replace(/\.ts$/, "")] = (
        await import(pathToFileURL(js))
      ).default;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

function flatten(value, prefix = "", into = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object") flatten(child, full, into);
    else into.set(full, child);
  }
  return into;
}

const variables = (text) =>
  [...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)]
    .map((m) => m[1])
    .sort()
    .join(",");
const tags = (text) =>
  [...text.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)>/g)]
    .map((m) => m[1])
    .sort()
    .join(",");

const fr = await loadLocale("fr");
const en = await loadLocale("en");
const problems = [];
let keyCount = 0;

const namespaces = new Set([...Object.keys(fr), ...Object.keys(en)]);
for (const ns of namespaces) {
  if (!fr[ns]) problems.push(`${ns} : namespace absent en français`);
  if (!en[ns]) problems.push(`${ns} : namespace absent en anglais`);
  if (!fr[ns] || !en[ns]) continue;
  const frKeys = flatten(fr[ns]);
  const enKeys = flatten(en[ns]);
  keyCount += frKeys.size;

  for (const [map, lang] of [
    [frKeys, "fr"],
    [enKeys, "en"],
  ]) {
    for (const [key, value] of map) {
      if (typeof value !== "string") {
        problems.push(`${ns}:${key} (${lang}) : valeur non textuelle`);
      } else if (value.trim() === "") {
        problems.push(`${ns}:${key} (${lang}) : valeur vide`);
      }
    }
  }

  for (const key of frKeys.keys()) {
    if (key.endsWith("_many")) continue;
    if (!enKeys.has(key))
      problems.push(`${ns}:${key} : traduction anglaise manquante`);
  }
  for (const key of enKeys.keys()) {
    if (!frKeys.has(key))
      problems.push(`${ns}:${key} : clé anglaise sans équivalent français`);
  }

  // Pluriels complets.
  const bases = new Set(
    [...frKeys.keys(), ...enKeys.keys()]
      .filter((k) => PLURAL.test(k))
      .map((k) => k.replace(PLURAL, "")),
  );
  for (const base of bases) {
    for (const form of ["one", "many", "other"]) {
      if (!frKeys.has(`${base}_${form}`)) {
        problems.push(
          `${ns}:${base} : forme plurielle française _${form} manquante`,
        );
      }
    }
    for (const form of ["one", "other"]) {
      if (!enKeys.has(`${base}_${form}`)) {
        problems.push(
          `${ns}:${base} : forme plurielle anglaise _${form} manquante`,
        );
      }
    }
  }

  // Variables et balises : identiques entre les langues (et entre formes).
  for (const [key, frValue] of frKeys) {
    if (typeof frValue !== "string") continue;
    const base = key.replace(PLURAL, "");
    const reference = PLURAL.test(key)
      ? (frKeys.get(`${base}_other`) ?? frValue)
      : frValue;
    const targets = PLURAL.test(key)
      ? [`${base}_one`, `${base}_other`].filter((k) => enKeys.has(k))
      : [key];
    if (PLURAL.test(key) && variables(frValue) !== variables(reference)) {
      // `_one` peut omettre {{count}} (« Afficher le suivant »).
      const relaxed = variables(frValue)
        .replace(/(^|,)count(,|$)/, "$1$2")
        .replace(/^,|,$/g, "");
      const refRelaxed = variables(reference)
        .replace(/(^|,)count(,|$)/, "$1$2")
        .replace(/^,|,$/g, "");
      if (relaxed !== refRelaxed) {
        problems.push(
          `${ns}:${key} : variables différentes de la forme _other`,
        );
      }
    }
    for (const target of targets) {
      const enValue = enKeys.get(target);
      if (typeof enValue !== "string") continue;
      const strip = (v) =>
        v.replace(/(^|,)count(,|$)/, "$1$2").replace(/^,|,$/g, "");
      const frVars = PLURAL.test(key)
        ? strip(variables(reference))
        : variables(frValue);
      const enVars = PLURAL.test(key)
        ? strip(variables(enValue))
        : variables(enValue);
      if (frVars !== enVars) {
        problems.push(
          `${ns}:${target} : variables {{${enVars}}} ≠ français {{${frVars}}}`,
        );
      }
      if (tags(reference) !== tags(enValue)) {
        problems.push(
          `${ns}:${target} : balises <${tags(enValue)}> ≠ français <${tags(reference)}>`,
        );
      }
    }
  }
}

// Rendu réel en anglais, sans repli : aucune clé ne doit sortir brute.
const instance = i18next.createInstance();
await instance.init({
  lng: "en",
  fallbackLng: false,
  resources: { en, fr },
  ns: [...namespaces],
  initAsync: false,
  interpolation: { escapeValue: false },
});
for (const ns of namespaces) {
  if (!fr[ns]) continue;
  for (const key of flatten(fr[ns]).keys()) {
    if (PLURAL.test(key)) continue;
    const rendered = instance.t(key, { ns });
    if (rendered === key) problems.push(`${ns}:${key} : non rendue en anglais`);
  }
}

const result = {
  ok: problems.length === 0,
  namespaces: namespaces.size,
  frenchKeys: keyCount,
  problems,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.ok ? 0 : 1;
