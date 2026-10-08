/**
 * 1-14D.2H — Vérification par CANARIS du build et du serveur web RÉELS
 * (`next build`, `next start` de la version installée), en environnement
 * temporaire (TEST). Lancée par : node api/test/recipe/recipe.js web-canary-check
 *
 * Chaque cas part d'une copie des sources web (sans aucun `.env*` réel :
 * `web-copy.js`) à laquelle sont ajoutés :
 * - des fichiers `.env`, `.env.local`, `.env.production`,
 *   `.env.production.local` et `.env.development.local` FICTIFS, chacun avec
 *   ses propres marqueurs (variables `NEXT_PUBLIC_*` et serveur) ;
 * - une page statique et une route dynamique de sonde qui exposent ces
 *   variables (prérendu au build, lecture à l'exécution).
 *
 * Cas :
 * - T1 témoin : canaris dans le dossier de build, ni garde ni
 *   `__NEXT_PROCESSED_ENV` → le contrôle DOIT détecter les valeurs ;
 * - T2 garde seule (configuration précédente) : canaris présents, garde et
 *   `__NEXT_PROCESSED_ENV` → valeurs non appliquées ; les accès JavaScript
 *   sont journalisés, une lecture native reste possible ;
 * - T3 copie isolée (configuration du lanceur) : les canaris sont dans la
 *   SOURCE, la copie les écarte → absents du dossier de build ;
 * - T4 copie isolée sans garde ni `__NEXT_PROCESSED_ENV` : l'isolement
 *   suffit à lui seul.
 *
 * Les marqueurs sont recherchés dans TOUT `.next` et dans les réponses HTTP
 * du serveur. Les dossiers sont créés sous la racine du dépôt (contrainte
 * Turbopack), puis supprimés.
 */
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const C = require('./recipe-common');
const W = require('./web-copy');

const ROOT = path.join(C.REPO, '.stockmaster-recipe-canary');
const PORT = 3299;
const NEXT_BIN = path.join(
  C.WEB_DIR,
  'node_modules',
  'next',
  'dist',
  'bin',
  'next',
);
const CANARY_FILES = Object.freeze([
  { file: '.env', id: 'ENV' },
  { file: '.env.local', id: 'ENV_LOCAL' },
  { file: '.env.production', id: 'ENV_PRODUCTION' },
  { file: '.env.production.local', id: 'ENV_PRODUCTION_LOCAL' },
  { file: '.env.development.local', id: 'ENV_DEVELOPMENT_LOCAL' },
]);
const STANDARD_ENV_NAMES = new Set(CANARY_FILES.map((c) => c.file));

function markers() {
  const run = crypto.randomBytes(4).toString('hex');
  return CANARY_FILES.map(({ file, id }) => ({
    file,
    id,
    publicName: `NEXT_PUBLIC_RECIPE_CANARY_${id}`,
    serverName: `RECIPE_CANARY_${id}`,
    publicValue: `canary-public-${id.toLowerCase()}-${run}`,
    serverValue: `canary-server-${id.toLowerCase()}-${run}`,
  }));
}

/** Fichiers fictifs écrits (jamais lus par ce module). */
function writeCanaries(directory, list) {
  for (const m of list) {
    fs.writeFileSync(
      path.join(directory, m.file),
      `${m.publicName}=${m.publicValue}\n${m.serverName}=${m.serverValue}\n`,
    );
  }
}

/** Sondes : page statique (prérendu au build) et route dynamique (exécution). */
function writeProbes(directory, list) {
  const pageDir = path.join(directory, 'src', 'app', 'recipe-canary');
  const routeDir = path.join(directory, 'src', 'app', 'recipe-canary-runtime');
  fs.mkdirSync(pageDir, { recursive: true });
  fs.mkdirSync(routeDir, { recursive: true });
  const entries = (kind) =>
    list
      .map(
        (m) =>
          `    ${m.id}: process.env.${kind === 'public' ? m.publicName : m.serverName} ?? null,`,
      )
      .join('\n');
  fs.writeFileSync(
    path.join(pageDir, 'page.tsx'),
    `// Sonde TEMPORAIRE de recette (jamais dans le dépôt).
export default function RecipeCanaryPage() {
  const values = {
    public: {
${entries('public')}
    },
    server: {
${entries('server')}
    },
  };
  return <pre id="recipe-canary">{JSON.stringify(values)}</pre>;
}
`,
  );
  fs.writeFileSync(
    path.join(routeDir, 'route.ts'),
    `// Sonde TEMPORAIRE de recette (jamais dans le dépôt).
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({
${entries('server')}
  });
}
`,
  );
}

/** Recherche binaire des marqueurs dans tous les fichiers d'un arbre. */
function scanTree(root, values) {
  const hits = new Map(values.map((v) => [v, []]));
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (entry.isFile()) {
        const content = fs.readFileSync(full);
        for (const value of values) {
          if (content.includes(value))
            hits.get(value).push(path.relative(root, full));
        }
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return hits;
}

function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // terminé
    }
  }
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: C.HOST, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function serveAndFetch(directory, env) {
  const child = spawn(
    process.execPath,
    [NEXT_BIN, 'start', '-H', C.HOST, '-p', String(PORT)],
    {
      cwd: directory,
      env: { ...env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    },
  );
  let output = '';
  child.stdout.on('data', (c) => (output += c));
  child.stderr.on('data', (c) => (output += c));
  try {
    const deadline = Date.now() + 60_000;
    while (!/Ready in/.test(output)) {
      if (child.exitCode !== null || /EADDRINUSE/.test(output))
        throw new Error(`next start : ${output.slice(-500)}`);
      if (Date.now() > deadline) throw new Error('next start : délai dépassé');
      await new Promise((r) => setTimeout(r, 200));
    }
    const base = `http://${C.HOST}:${PORT}`;
    const page = await (await fetch(`${base}/recipe-canary`)).text();
    const runtime = await (await fetch(`${base}/recipe-canary-runtime`)).text();
    return { page, runtime, output };
  } finally {
    killTree(child);
  }
}

function build(directory, env) {
  const result = spawnSync(process.execPath, [NEXT_BIN, 'build'], {
    cwd: directory,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 600_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `next build (code ${result.status}) : ${(result.stdout + result.stderr).slice(-1500)}`,
    );
  }
  return result.stdout + result.stderr;
}

/** Fichiers `.env*` standards dans le dossier de build et ses ancêtres (noms seulement). */
function envNamesAround(directory) {
  const present = [];
  let current = directory;
  for (;;) {
    for (const name of fs.readdirSync(current)) {
      if (STANDARD_ENV_NAMES.has(name)) present.push(path.join(current, name));
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return present;
}

/**
 * Canaris (noms `.env*`) supprimés explicitement par `unlinkSync` : ce
 * processus est lui-même gardé, `rmSync` ne les « verrait » pas.
 */
function removeEnvFiles(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (W.ENV_FILE.test(entry.name)) fs.unlinkSync(full);
    else if (entry.isDirectory() && entry.name !== 'node_modules')
      removeEnvFiles(full);
  }
}

async function runCase(spec, list, guardLog) {
  const caseDir = path.join(ROOT, spec.id);
  const sourceDir = path.join(ROOT, `${spec.id}-source`);
  const nodeModules = path.join(C.WEB_DIR, 'node_modules');
  let excluded = [];
  if (spec.isolated) {
    // Source = sources web + sondes + canaris ; la copie isolée les écarte.
    W.prepareIsolatedWeb(C.WEB_DIR, sourceDir, nodeModules);
    writeProbes(sourceDir, list);
    writeCanaries(sourceDir, list);
    excluded = W.prepareIsolatedWeb(
      sourceDir,
      caseDir,
      nodeModules,
    ).excludedEnvFiles;
    removeEnvFiles(sourceDir);
    W.removeIsolatedWeb(sourceDir);
  } else {
    W.prepareIsolatedWeb(C.WEB_DIR, caseDir, nodeModules);
    writeProbes(caseDir, list);
    writeCanaries(caseDir, list);
  }
  const envFilesInBuildDir = fs
    .readdirSync(caseDir)
    .filter((name) => W.ENV_FILE.test(name));
  const env = spec.protected
    ? C.webEnv({ RECIPE_ENV_GUARD_LOG: guardLog })
    : C.webEnv();
  if (!spec.protected) {
    delete env.NODE_OPTIONS;
    delete env.__NEXT_PROCESSED_ENV;
    delete env.RECIPE_ENV_GUARD_LOG;
  }
  const buildOutput = build(caseDir, env);
  const served = await serveAndFetch(caseDir, env);
  const values = list.flatMap((m) => [m.publicValue, m.serverValue]);
  const inBuild = scanTree(path.join(caseDir, '.next'), values);
  const applied = list.map((m) => ({
    file: m.file,
    publicInBuild: inBuild.get(m.publicValue).length > 0,
    serverInBuild: inBuild.get(m.serverValue).length > 0,
    publicServed: served.page.includes(m.publicValue),
    serverServedAtRuntime: served.runtime.includes(m.serverValue),
  }));
  const guardAttempts = fs.existsSync(guardLog)
    ? fs
        .readFileSync(guardLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((l) => path.resolve(l.directory) === path.resolve(caseDir))
        .map((l) => `${l.operation} ${l.file}`)
    : [];
  const environmentsLine = (buildOutput + served.output)
    .split('\n')
    .filter((l) => /Environments?:/.test(l));
  const result = {
    id: spec.id,
    title: spec.title,
    envFilesInBuildDir,
    excludedByCopy: excluded,
    standardEnvNamesInAncestors: envNamesAround(path.dirname(caseDir)),
    applied,
    anyApplied: applied.some(
      (a) =>
        a.publicInBuild ||
        a.serverInBuild ||
        a.publicServed ||
        a.serverServedAtRuntime,
    ),
    guardAttempts: [...new Set(guardAttempts)].sort(),
    nextEnvironmentsLines: environmentsLine.map((l) => l.trim()),
  };
  removeEnvFiles(caseDir);
  W.removeIsolatedWeb(caseDir);
  return result;
}

const CASES = Object.freeze([
  {
    id: 'T1',
    title: 'Témoin : canaris dans le dossier de build, aucune protection',
    protected: false,
    isolated: false,
    expectApplied: true,
  },
  {
    id: 'T2',
    title:
      'Garde + __NEXT_PROCESSED_ENV, canaris présents (configuration précédente)',
    protected: true,
    isolated: false,
    expectApplied: false,
  },
  {
    id: 'T3',
    title: 'Copie isolée + garde (configuration du lanceur)',
    protected: true,
    isolated: true,
    expectApplied: false,
  },
  {
    id: 'T4',
    title: 'Copie isolée seule, sans garde ni __NEXT_PROCESSED_ENV',
    protected: false,
    isolated: true,
    expectApplied: false,
  },
]);

async function webCanaryCheck() {
  if (await portInUse(PORT))
    throw new Error(
      `Port ${PORT} déjà utilisé : aucun processus n'est arrêté.`,
    );
  W.removeIsolatedWeb(ROOT);
  fs.mkdirSync(ROOT, { recursive: true });
  const guardLog = path.join(ROOT, 'guard.jsonl');
  const list = markers();
  const results = [];
  try {
    for (const spec of CASES) {
      process.stderr.write(`[canaris] ${spec.id} ${spec.title} …\n`);
      const result = await runCase(spec, list, guardLog);
      result.expectApplied = spec.expectApplied;
      result.pass =
        spec.id === 'T1'
          ? // Le témoin doit détecter les 4 fichiers chargés en production.
            result.applied
              .filter((a) => a.file !== '.env.development.local')
              .every(
                (a) =>
                  a.publicInBuild && a.publicServed && a.serverServedAtRuntime,
              )
          : !result.anyApplied &&
            (!spec.isolated || result.envFilesInBuildDir.length === 0);
      results.push(result);
    }
  } finally {
    removeEnvFiles(ROOT);
    for (const entry of fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : [])
      W.removeIsolatedWeb(path.join(ROOT, entry));
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
  return { pass: results.every((r) => r.pass), results };
}

module.exports = { webCanaryCheck };
