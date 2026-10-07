#!/usr/bin/env node
// 1-16C.2 — Archive des documents juridiques soumis à acceptation.
//
// Le texte archivé est celui que la page PRÉSENTE (régions `data-legal-text`
// du gabarit `components/legal/document-page.tsx` : titre, version,
// introduction et sections ; ni sommaire, ni en-tête, ni pied de page). La
// langue est celle de `<html lang>`, la version celle de `data-legal-version`.
//
// 1-16G : les pages sont rendues à la requête, dans la langue choisie
// (cookie `stockmaster.lang`). Le script démarre donc `next start` sur le
// build (`--next-dir`), ou utilise un serveur déjà lancé (`--base-url`), et
// lit le HTML servi pour CHAQUE langue publiée (fr, en).
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
// - Aucune dépendance ; seul accès réseau : le serveur local 127.0.0.1 du
//   build. Seuls `api/src/legal/archive/` (en `write`) et la sortie
//   standard sont écrits.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE_DIR = path.resolve(SCRIPT_DIR, "../../api/src/legal/archive");
const MANIFEST = path.join(ARCHIVE_DIR, "manifest.json");
const VERSION_PATTERN = /^\d+\.\d+$/;
const LOCALE_PATTERN = /^[a-z]{2}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Langues publiées des documents versionnés (1-16G). */
const PUBLISHED_LOCALES = ["fr", "en"];
const LOCALE_COOKIE = "stockmaster.lang";

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);
const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "caption",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "section",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "tr",
  "ul",
]);
const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
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

/**
 * 1-16G — Texte RÉELLEMENT servi d'une page, dans une langue : la page est
 * demandée au serveur Next (rendu dynamique) avec le cookie de langue, comme
 * un navigateur. La langue lue dans `<html lang>` doit être celle demandée.
 */
async function presentedPage(baseUrl, route, locale) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: {
      cookie: `${LOCALE_COOKIE}=${locale}`,
      "accept-language": locale,
    },
    redirect: "manual",
  });
  if (response.status !== 200) {
    throw new Error(`${route} (${locale}) : réponse HTTP ${response.status}`);
  }
  const html = await response.text();
  const servedLocale = /<html[^>]*\slang="([^"]*)"/.exec(html)?.[1] ?? "";
  const version = /\sdata-legal-version="([^"]*)"/.exec(html)?.[1] ?? "";
  const id = /\sdata-legal-document="([^"]*)"/.exec(html)?.[1] ?? "";
  if (!LOCALE_PATTERN.test(servedLocale))
    throw new Error(`${route} : langue invalide`);
  if (servedLocale !== locale) {
    throw new Error(`${route} : langue servie ${servedLocale} ≠ ${locale}`);
  }
  if (!VERSION_PATTERN.test(version))
    throw new Error(`${route} : version invalide`);
  return {
    id,
    locale: servedLocale,
    version,
    text: extractPresentedText(html),
  };
}

/**
 * Démarre `next start` sur le build indiqué (port libre, 127.0.0.1), attend
 * qu'il réponde, et renvoie de quoi l'arrêter. Le dossier de travail est
 * celui du projet web du build (copie isolée en recette).
 */
async function startServer(nextDir) {
  const projectDir = path.dirname(nextDir);
  if (!fs.existsSync(path.join(nextDir, "BUILD_ID"))) {
    throw new Error(
      `Build Next absent : ${path.relative(process.cwd(), nextDir)}`,
    );
  }
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const require = createRequire(path.join(projectDir, "package.json"));
  const nextBin = require.resolve("next/dist/bin/next");
  const child = spawn(
    process.execPath,
    [nextBin, "start", "-p", String(port), "-H", "127.0.0.1"],
    {
      cwd: projectDir,
      env: { ...process.env, NODE_ENV: "production" },
      stdio: "ignore",
    },
  );
  const baseUrl = `http://127.0.0.1:${port}`;
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill();
      setTimeout(resolve, 5000).unref();
    });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("next start s'est arrêté");
    try {
      const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
      if (res.status > 0) return { baseUrl, stop };
    } catch {
      // serveur pas encore prêt
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await stop();
  throw new Error("next start n'a pas répondu à temps");
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
          problems.push(
            `${id} ${version} ${locale} : archive modifiée (empreinte différente)`,
          );
        }
      }
    }
  }
}

async function check(source) {
  const manifest = readManifest();
  const problems = [];
  verifyArchives(manifest, problems);
  const checked = [];
  for (const [id, doc] of Object.entries(manifest.documents)) {
    for (const locale of PUBLISHED_LOCALES) {
      const page = await source.page(doc.route, locale);
      if (page.id !== id) {
        problems.push(
          `${doc.route} (${locale}) : document ${page.id || "?"} ≠ ${id}`,
        );
      }
      if (page.version !== doc.current) {
        problems.push(
          `${id} (${locale}) : version affichée ${page.version} ≠ version courante archivée ${doc.current}`,
        );
        continue;
      }
      const entry = doc.versions[doc.current]?.locales[page.locale];
      if (!entry) {
        problems.push(
          `${id} ${page.version} : langue ${page.locale} non archivée`,
        );
        continue;
      }
      if (sha256(page.text) !== entry.sha256) {
        problems.push(
          `${id} ${page.version} ${page.locale} : le texte affiché diffère de l'archive. ` +
            "Créer une nouvelle version, puis l'archiver (write).",
        );
        continue;
      }
      checked.push({
        id,
        version: page.version,
        locale: page.locale,
        sha256: entry.sha256,
      });
    }
  }
  return { ok: problems.length === 0, checked, problems };
}

async function write(source, publishedAt) {
  if (!DATE_PATTERN.test(publishedAt ?? "")) {
    throw new Error("--published-at AAAA-MM-JJ requis");
  }
  const manifest = readManifest();
  const problems = [];
  verifyArchives(manifest, problems);
  if (problems.length) return { ok: false, written: [], problems };
  const written = [];
  for (const [id, doc] of Object.entries(manifest.documents)) {
    for (const locale of PUBLISHED_LOCALES) {
      const page = await source.page(doc.route, locale);
      if (page.id !== id) {
        problems.push(
          `${doc.route} (${locale}) : document ${page.id || "?"} ≠ ${id}`,
        );
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
        problems.push(
          `${relative} existe sans entrée de manifeste : rien n'est écrasé`,
        );
        continue;
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, page.text, { flag: "wx" });
      doc.versions[page.version] ??= { publishedAt, locales: {} };
      doc.versions[page.version].locales[page.locale] = {
        file: relative,
        sha256: hash,
      };
      doc.current = page.version;
      written.push({
        id,
        version: page.version,
        locale: page.locale,
        sha256: hash,
      });
    }
  }
  if (written.length) writeManifest(manifest);
  return { ok: problems.length === 0, written, problems };
}

async function main(argv) {
  const [mode, ...rest] = argv;
  const option = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const nextDir = option("--next-dir");
  const baseUrl = option("--base-url");
  if ((!nextDir && !baseUrl) || (mode !== "check" && mode !== "write")) {
    process.stderr.write(
      "Usage : legal-archive.mjs check|write (--next-dir <dossier .next> | --base-url <url>) [--published-at AAAA-MM-JJ]\n",
    );
    return 2;
  }
  const server = baseUrl
    ? { baseUrl: baseUrl.replace(/\/+$/, ""), stop: async () => {} }
    : await startServer(path.resolve(nextDir));
  try {
    const source = {
      page: (route, locale) => presentedPage(server.baseUrl, route, locale),
    };
    const result =
      mode === "check"
        ? await check(source)
        : await write(source, option("--published-at"));
    process.stdout.write(`${JSON.stringify({ mode, ...result }, null, 2)}\n`);
    return result.ok ? 0 : 1;
  } finally {
    await server.stop();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `legal-archive : ${error instanceof Error ? error.message : error}\n`,
    );
    process.exitCode = 1;
  }
}
