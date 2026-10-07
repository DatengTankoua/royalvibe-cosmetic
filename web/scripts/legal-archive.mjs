#!/usr/bin/env node
// 1-16C.2 — Archive des documents juridiques soumis à acceptation.
//
// Le texte archivé est celui que la page PRÉSENTE : il est extrait du HTML
// prérendu par `next build` (régions `data-legal-text` du gabarit
// `components/legal/document-page.tsx` : titre, version, introduction et
// sections ; ni sommaire, ni en-tête, ni pied de page). La langue est celle
// de `<html lang>`, la version celle de `data-legal-version`.
//
// Usage (depuis la racine du dépôt, après un build web) :
//   node web/scripts/legal-archive.mjs check --next-dir web/.next
//   node web/scripts/legal-archive.mjs write --next-dir web/.next --published-at 2026-10-07
//
// - `check` (CI, recette) : pour chaque document du manifeste, la version
//   affichée doit être la version courante, et le texte extrait doit être
//   IDENTIQUE à son archive ; chaque archive doit correspondre à l'empreinte
//   du manifeste. Sortie 1 sinon : un texte modifié exige une NOUVELLE
//   version (`web/src/lib/legal/site-identity.ts`), puis `write`.
// - `write` : archive la version affichée si elle est nouvelle (fichier et
//   entrée du manifeste) et la rend courante. Une version déjà archivée
//   n'est JAMAIS réécrite : texte différent → refus, sortie 1.
// - Aucune dépendance, aucun accès réseau ; seuls `api/src/legal/archive/`
//   (en `write`) et la sortie standard sont écrits.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE_DIR = path.resolve(SCRIPT_DIR, "../../api/src/legal/archive");
const MANIFEST = path.join(ARCHIVE_DIR, "manifest.json");
const VERSION_PATTERN = /^\d+\.\d+$/;
const LOCALE_PATTERN = /^[a-z]{2}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "source", "track", "wbr",
]);
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "br", "caption", "dd", "div",
  "dl", "dt", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
  "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p",
  "section", "table", "tbody", "tfoot", "thead", "tr", "ul",
]);
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    if (named === undefined) throw new Error(`Entité HTML inconnue : ${match}`);
    return named;
  });
}

function attribute(attrs, name) {
  const m = new RegExp(`\\s${name}(?:="([^"]*)")?(?=\\s|$)`).exec(attrs);
  return m ? (m[1] ?? "") : null;
}

// Le HTML de React est bien formé : texte et attributs échappés (`<`, `>`,
// `&`, `"`, `'`), valeurs entre guillemets doubles. Un découpage par
// expression régulière y est donc sûr.
const TOKEN =
  /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g;

/** Texte présenté d'une page : lignes normalisées, terminées par `\n`. */
export function extractPresentedText(html) {
  const lines = [];
  let line = "";
  let depth = 0;
  let regions = 0;
  const flush = () => {
    const value = line.replace(/[ \t\r\n ]+/g, " ").trim();
    if (value && value !== "-") lines.push(value);
    line = "";
  };
  for (const m of html.matchAll(TOKEN)) {
    const [, closing, rawName, attrs = "", text] = m;
    if (text !== undefined) {
      if (depth > 0) line += decodeEntities(text);
      continue;
    }
    if (!rawName) continue; // commentaire
    const name = rawName.toLowerCase();
    if (depth === 0) {
      if (!closing && attribute(attrs, "data-legal-text") !== null) {
        if (VOID.has(name)) throw new Error("Région data-legal-text vide");
        depth = 1;
        regions += 1;
        flush();
      }
      continue;
    }
    if (closing) {
      if (VOID.has(name)) continue;
      depth -= 1;
      if (BLOCK.has(name) || depth === 0) flush();
      continue;
    }
    if (name === "script" || name === "style") {
      throw new Error(`<${name}> inattendu dans le texte d'un document`);
    }
    if (!VOID.has(name)) depth += 1;
    if (BLOCK.has(name)) flush();
    if (name === "li") line = "- ";
    if ((name === "td" || name === "th") && line.trim()) line += " | ";
  }
  if (depth !== 0) throw new Error("Région data-legal-text non fermée");
  if (regions === 0) throw new Error("Aucune région data-legal-text");
  return `${lines.join("\n")}\n`;
}

function presentedPage(nextDir, route) {
  const file = path.join(nextDir, "server", "app", `${route.slice(1)}.html`);
  if (!fs.existsSync(file)) {
    throw new Error(`Page prérendue absente : ${path.relative(process.cwd(), file)}`);
  }
  const html = fs.readFileSync(file, "utf8");
  const locale = /<html[^>]*\slang="([^"]*)"/.exec(html)?.[1] ?? "";
  const version = /\sdata-legal-version="([^"]*)"/.exec(html)?.[1] ?? "";
  const id = /\sdata-legal-document="([^"]*)"/.exec(html)?.[1] ?? "";
  if (!LOCALE_PATTERN.test(locale)) throw new Error(`${route} : langue invalide`);
  if (!VERSION_PATTERN.test(version)) throw new Error(`${route} : version invalide`);
  return { id, locale, version, text: extractPresentedText(html) };
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
}

function writeManifest(manifest) {
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}

function archivePath(relative) {
  const full = path.resolve(ARCHIVE_DIR, relative);
  if (!full.startsWith(ARCHIVE_DIR + path.sep)) {
    throw new Error(`Chemin d'archive hors du dossier : ${relative}`);
  }
  return full;
}

/** Archives existantes : empreinte du fichier = empreinte du manifeste. */
function verifyArchives(manifest, problems) {
  for (const [id, doc] of Object.entries(manifest.documents)) {
    for (const [version, entry] of Object.entries(doc.versions)) {
      for (const [locale, file] of Object.entries(entry.locales)) {
        const full = archivePath(file.file);
        if (!fs.existsSync(full)) {
          problems.push(`${id} ${version} ${locale} : archive absente`);
        } else if (sha256(fs.readFileSync(full)) !== file.sha256) {
          problems.push(`${id} ${version} ${locale} : archive modifiée (empreinte différente)`);
        }
      }
    }
  }
}

function check(nextDir) {
  const manifest = readManifest();
  const problems = [];
  verifyArchives(manifest, problems);
  const checked = [];
  for (const [id, doc] of Object.entries(manifest.documents)) {
    const page = presentedPage(nextDir, doc.route);
    if (page.id !== id) problems.push(`${doc.route} : document ${page.id || "?"} ≠ ${id}`);
    if (page.version !== doc.current) {
      problems.push(`${id} : version affichée ${page.version} ≠ version courante archivée ${doc.current}`);
      continue;
    }
    const entry = doc.versions[doc.current]?.locales[page.locale];
    if (!entry) {
      problems.push(`${id} ${page.version} : langue ${page.locale} non archivée`);
      continue;
    }
    if (sha256(page.text) !== entry.sha256) {
      problems.push(
        `${id} ${page.version} ${page.locale} : le texte affiché diffère de l'archive. ` +
          "Créer une nouvelle version, puis l'archiver (write).",
      );
      continue;
    }
    checked.push({ id, version: page.version, locale: page.locale, sha256: entry.sha256 });
  }
  return { ok: problems.length === 0, checked, problems };
}

function write(nextDir, publishedAt) {
  if (!DATE_PATTERN.test(publishedAt ?? "")) {
    throw new Error("--published-at AAAA-MM-JJ requis");
  }
  const manifest = readManifest();
  const problems = [];
  verifyArchives(manifest, problems);
  if (problems.length) return { ok: false, written: [], problems };
  const written = [];
  for (const [id, doc] of Object.entries(manifest.documents)) {
    const page = presentedPage(nextDir, doc.route);
    if (page.id !== id) {
      problems.push(`${doc.route} : document ${page.id || "?"} ≠ ${id}`);
      continue;
    }
    const hash = sha256(page.text);
    const existing = doc.versions[page.version]?.locales[page.locale];
    if (existing) {
      if (existing.sha256 !== hash) {
        problems.push(
          `${id} ${page.version} ${page.locale} : version déjà archivée avec un autre texte. ` +
            "Une version archivée n'est jamais réécrite : créer une nouvelle version.",
        );
      }
      continue;
    }
    const relative = `${id}/${page.version}.${page.locale}.txt`;
    const full = archivePath(relative);
    if (fs.existsSync(full)) {
      problems.push(`${relative} existe sans entrée de manifeste : rien n'est écrasé`);
      continue;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, page.text, { flag: "wx" });
    doc.versions[page.version] ??= { publishedAt, locales: {} };
    doc.versions[page.version].locales[page.locale] = { file: relative, sha256: hash };
    doc.current = page.version;
    written.push({ id, version: page.version, locale: page.locale, sha256: hash });
  }
  if (written.length) writeManifest(manifest);
  return { ok: problems.length === 0, written, problems };
}

function main(argv) {
  const [mode, ...rest] = argv;
  const option = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const nextDir = option("--next-dir");
  if (!nextDir || (mode !== "check" && mode !== "write")) {
    process.stderr.write(
      "Usage : legal-archive.mjs check|write --next-dir <dossier .next> [--published-at AAAA-MM-JJ]\n",
    );
    return 2;
  }
  const result =
    mode === "check"
      ? check(path.resolve(nextDir))
      : write(path.resolve(nextDir), option("--published-at"));
  process.stdout.write(`${JSON.stringify({ mode, ...result }, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`legal-archive : ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
