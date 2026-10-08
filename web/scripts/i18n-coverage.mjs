#!/usr/bin/env node
// 1-16G — Inventaire de couverture des textes de l'interface web.
//
// Analyse `web/src/**/*.{ts,tsx}` avec le compilateur TypeScript et relève
// les textes destinés aux utilisateurs restés écrits en dur :
// - texte JSX (`<p>Bonjour</p>`) ;
// - attributs visibles ou lus par les lecteurs d'écran (`aria-label`,
//   `title`, `placeholder`, `alt`, `label`, `caption`…), littéraux ;
// - chaînes passées à `toast*()`, `setError()`/`setMessage()`… ;
// - littéraux de chaîne contenant une lettre accentuée française.
//
// Exclusions (documentées) : ressources de traduction et contenus de
// documents (`src/i18n/`), composants hérités `components/objects/` (code
// mort : importés nulle part, jamais affichés), commentaires, imports,
// clés de stockage et codes techniques, noms propres listés ci-dessous, et
// le registre français `lib/legal/site-identity.ts` (données éditoriales
// sources, traduites dans les contenus anglais).
//
// Usage : node web/scripts/i18n-coverage.mjs [--json] [--fail]
//   --fail : sortie 1 si au moins un texte est relevé (contrôle relançable).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const EXCLUDED_DIRS = [
  path.join(SRC, "i18n"),
  path.join(SRC, "components", "objects"),
];
const EXCLUDED_FILES = [path.join(SRC, "lib", "legal", "site-identity.ts")];
// Textes volontairement non traduits : noms propres, marque, unités.
const ALLOWED = new Set([
  "Stock Master",
  "by Stock Master",
  "FCFA",
  "Français",
  "English",
  "EUR",
  "XAF",
  "Excel",
  "PDF",
  "Mobile Money",
  "MTN Mobile Money",
  "Orange Money",
  "6XX XX XX XX",
  "EUR ↔ CFA",
  "—",
  "→",
  "×",
  "·",
  "=",
  "…",
]);
const VISIBLE_ATTRIBUTES = new Set([
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "aria-valuetext",
  "title",
  "placeholder",
  "alt",
  "label",
  "caption",
  "description",
  "confirmLabel",
  "cancelLabel",
]);
const MESSAGE_CALLS =
  /^(toast(\.\w+)?|set\w*(Error|Message|Notice|Status|Text|Label)|alert|confirm)$/;
const FRENCH_LETTER = /[àâäçéèêëîïôöùûüÿœæÀÂÇÉÈÊËÎÏÔÙÛÜŸŒÆ]/;
const HAS_WORDS = /[A-Za-zÀ-ÿ]{2,}/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.includes(full)) walk(full, out);
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts") &&
      !EXCLUDED_FILES.includes(full)
    ) {
      out.push(full);
    }
  }
  return out;
}

function normalise(text) {
  return text.replace(/\s+/g, " ").trim();
}

function interesting(text) {
  const value = normalise(text);
  if (!value || ALLOWED.has(value)) return false;
  return HAS_WORDS.test(value);
}

function isTechnical(value) {
  // Clés, codes, chemins, classes CSS, URL, formats : aucun espace ni
  // ponctuation de phrase, ou motif reconnaissable.
  if (/^[\w.:/@#?=&%-]+$/.test(value)) return true;
  if (/^(https?:|mailto:|\/|#|\.\/)/.test(value)) return true;
  if (
    /^[a-z0-9-]+(:[a-z0-9-[\]/().%]+)?( [a-z0-9-]+(:[a-z0-9-[\]/().%_#]+)?)*$/.test(
      value,
    )
  ) {
    return true; // classes utilitaires
  }
  return false;
}

function scan(file) {
  const source = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings = [];
  const add = (node, kind, text) => {
    const value = normalise(text);
    if (!interesting(value)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    findings.push({
      file: path.relative(ROOT, file).replaceAll("\\", "/"),
      line: line + 1,
      kind,
      text: value.length > 120 ? `${value.slice(0, 117)}…` : value,
    });
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isJsxText(node)) {
      const value = normalise(node.text);
      if (value && /[A-Za-zÀ-ÿ]/.test(value)) add(node, "jsx-text", value);
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      const init = node.initializer;
      if (VISIBLE_ATTRIBUTES.has(name) && init) {
        if (ts.isStringLiteral(init)) add(init, `attr:${name}`, init.text);
        else if (
          ts.isJsxExpression(init) &&
          init.expression &&
          (ts.isStringLiteral(init.expression) ||
            ts.isNoSubstitutionTemplateLiteral(init.expression))
        ) {
          add(init, `attr:${name}`, init.expression.text);
        }
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if (MESSAGE_CALLS.test(callee)) {
        for (const arg of node.arguments) {
          if (
            ts.isStringLiteral(arg) ||
            ts.isNoSubstitutionTemplateLiteral(arg)
          ) {
            if (!isTechnical(arg.text)) add(arg, `call:${callee}`, arg.text);
          } else if (ts.isTemplateExpression(arg)) {
            add(arg, `call:${callee}`, arg.getText(sf));
          }
        }
      }
    } else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      FRENCH_LETTER.test(node.text) &&
      !isTechnical(node.text)
    ) {
      // Message de développement (`throw new Error(...)`, `console.*`) :
      // documentation, pas texte d'interface.
      const parent = node.parent;
      const devOnly =
        (parent &&
          ts.isNewExpression(parent) &&
          /Error$/.test(parent.expression.getText(sf))) ||
        (parent &&
          ts.isCallExpression(parent) &&
          /^(console\.|warnGeneric$)/.test(parent.expression.getText(sf)));
      if (!devOnly) add(node, "string", node.text);
    } else if (ts.isTemplateExpression(node)) {
      const raw = node.getText(sf);
      if (FRENCH_LETTER.test(raw)) {
        const parent = node.parent;
        const devOnly =
          parent &&
          ts.isNewExpression(parent) &&
          /Error$/.test(parent.expression.getText(sf));
        if (!devOnly) add(node, "template", raw);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

const files = walk(SRC);
const findings = files.flatMap(scan);
const byFile = new Map();
for (const f of findings) {
  byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
}

if (process.argv.includes("--json")) {
  process.stdout.write(
    `${JSON.stringify({ scannedFiles: files.length, findings }, null, 2)}\n`,
  );
} else {
  for (const [file, list] of byFile) {
    process.stdout.write(`\n${file}\n`);
    for (const f of list) {
      process.stdout.write(`  ${f.line}\t${f.kind}\t${f.text}\n`);
    }
  }
  process.stdout.write(
    `\n${files.length} fichiers analysés, ${findings.length} texte(s) relevé(s) dans ${byFile.size} fichier(s).\n`,
  );
}
process.exitCode =
  process.argv.includes("--fail") && findings.length > 0 ? 1 : 0;
