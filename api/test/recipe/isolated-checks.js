/**
 * 1-15A — Validations du dépôt ISOLÉES des `.env` réels (TEST).
 *
 * Reprend les protections de 1-14D.2H :
 * - environnement construit variable par variable (`baseEnv` : liste
 *   blanche système, aucune variable applicative héritée) ;
 * - garde anti-`.env` préchargée par `NODE_OPTIONS` dans CHAQUE processus
 *   JavaScript, workers Jest compris (`preload.cjs`) ;
 * - build Next dans la copie isolée sans aucun `.env*` (`web-copy.js`),
 *   seule protection valable aussi pour ses composants natifs.
 *
 * Aucun `.env` réel n'est ouvert, déplacé ni modifié : les `.env` de `api/`
 * ne sont visés que par des tentatives BLOQUÉES (nommées dans le journal de
 * la garde, jamais lues) ; ceux de `web/` sont écartés de la copie sur leur
 * seul nom.
 *
 * Usage (racine du dépôt) :
 *   node api/test/recipe/recipe.js isolated selftest   auto-test Jest : .env factices, garde, témoin
 *   node api/test/recipe/recipe.js isolated api-unit   jest (équivalent de `pnpm --filter api test`)
 *   node api/test/recipe/recipe.js isolated api-e2e    jest e2e (`test:e2e`)
 *   node api/test/recipe/recipe.js isolated web-build  next build dans la copie isolée
 * 1-15D : `api-unit` et `api-e2e` acceptent des motifs de chemins de tests
 * (`isolated api-e2e sale-history-purge`), validés et transmis à Jest ; la
 * garde et l'environnement construit restent identiques.
 * Le témoin du build web est `recipe.js web-canary-check` (1-14D.2H).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const C = require('./recipe-common');
const {
  prepareIsolatedWeb,
  removeIsolatedWeb,
  findEnvFiles,
} = require('./web-copy');

const JEST_BIN = path.join(
  path.dirname(require.resolve('jest/package.json', { paths: [C.API_DIR] })),
  'bin',
  'jest.js',
);
const NEXT_BIN = path.join(
  C.WEB_DIR,
  'node_modules',
  'next',
  'dist',
  'bin',
  'next',
);

function run(command, args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('exit', (code) => resolve(code === null ? 1 : code));
  });
}

function newLog(label) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), `stockmaster-isolated-${label}-`),
  );
  return { dir, file: path.join(dir, 'env-guard.jsonl') };
}

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Tentatives bloquées regroupées (noms et dossiers seulement). */
function summarize(entries) {
  const counts = {};
  for (const e of entries) {
    const key = `${e.operation} ${path.join(e.directory, e.file)}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/** Environnement construit : aucune variable héritée hors liste blanche. */
function isolatedEnv(log, extra = {}) {
  return C.baseEnv({ RECIPE_ENV_GUARD_LOG: log, ...extra });
}

// Dossiers temporaires où la suite e2e D.2G écrit ses PROPRES `.env`
// factices (témoin de régression de l'incident) : seule exception à la
// garde, jamais sous le dépôt.
const TEST_OWNED_ENV_PREFIXES = [
  path.join(os.tmpdir(), 'reconcile-cli-14d2g-'),
];

// ─── Auto-test : .env factices, garde, témoin positif ───────────────────────

const PROBE = (resultDir, name) => `
const fs = require('fs');
const path = require('path');
test('probe ${name}', async () => {
  const out = { pid: process.pid, cwd: process.cwd() };
  const { ConfigModule } = require(${JSON.stringify(
    require.resolve('@nestjs/config', { paths: [C.API_DIR] }),
  )});
  // Même appel que AppModule : .env du répertoire courant, sans chemin.
  await ConfigModule.forRoot({});
  out.nestConfig = process.env.RECIPE_CANARY_API || null;
  delete process.env.RECIPE_CANARY_API;
  const dotenv = require(${JSON.stringify(
    require.resolve('dotenv', {
      paths: [
        path.dirname(require.resolve('@nestjs/config', { paths: [C.API_DIR] })),
      ],
    }),
  )});
  dotenv.config({ quiet: true });
  out.dotenv = process.env.RECIPE_CANARY_API || null;
  delete process.env.RECIPE_CANARY_API;
  let direct = null;
  try { direct = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8'); } catch {}
  out.directRead = direct === null ? null : direct.includes('leaked') ? 'leaked' : 'other';
  fs.writeFileSync(path.join(${JSON.stringify(resultDir)}, '${name}-' + process.pid + '.json'), JSON.stringify(out));
});
`;

async function selftest() {
  const work = fs.mkdtempSync(
    path.join(os.tmpdir(), 'stockmaster-isolated-selftest-'),
  );
  const canaries = ['.env', '.env.local', '.env.test', '.env.development'];
  const outcome = {};
  try {
    for (const name of canaries) {
      fs.writeFileSync(path.join(work, name), 'RECIPE_CANARY_API=leaked\n');
    }
    fs.writeFileSync(
      path.join(work, 'jest.config.json'),
      JSON.stringify({
        rootDir: work,
        testEnvironment: 'node',
        testRegex: 'probe-.*\\.test\\.js$',
      }),
    );
    for (const mode of ['guarded', 'control']) {
      const results = path.join(work, `results-${mode}`);
      fs.mkdirSync(results);
      for (const name of ['a', 'b', 'c']) {
        fs.writeFileSync(
          path.join(work, `probe-${name}.test.js`),
          PROBE(results, name),
        );
      }
      const log = path.join(work, `guard-${mode}.jsonl`);
      // Gardé : MÊME configuration que les e2e, exception D.2G comprise
      // (elle ne doit ouvrir aucun autre dossier).
      const env = isolatedEnv(log, {
        RECIPE_ENV_GUARD_ALLOW_PREFIXES: TEST_OWNED_ENV_PREFIXES.join(
          path.delimiter,
        ),
      });
      if (mode === 'control') delete env.NODE_OPTIONS; // témoin positif : aucune garde
      // 3 fichiers, 2 workers : les probes tournent dans des workers Jest.
      const code = await run(
        process.execPath,
        [
          JEST_BIN,
          '--config',
          'jest.config.json',
          '--maxWorkers=2',
          '--no-cache',
        ],
        { cwd: work, env },
      );
      const probes = fs
        .readdirSync(results)
        .map((f) => JSON.parse(fs.readFileSync(path.join(results, f), 'utf8')));
      outcome[mode] = {
        jestExit: code,
        probes: probes.map(({ pid, nestConfig, dotenv, directRead }) => ({
          pid,
          nestConfig,
          dotenv,
          directRead,
        })),
        workers: new Set(probes.map((p) => p.pid)).size,
        blocked: summarize(readLog(log)),
      };
    }
    const g = outcome.guarded;
    const c = outcome.control;
    const pass =
      g.jestExit === 0 &&
      c.jestExit === 0 &&
      g.probes.length === 3 &&
      c.probes.length === 3 &&
      g.probes.every((p) => !p.nestConfig && !p.dotenv && !p.directRead) &&
      c.probes.every(
        (p) =>
          p.nestConfig === 'leaked' &&
          p.dotenv === 'leaked' &&
          p.directRead === 'leaked',
      ) &&
      Object.keys(g.blocked).length > 0;
    return { pass, ...outcome };
  } finally {
    // Ce processus est gardé (preload) : suppression explicite des canaris.
    for (const name of canaries) {
      try {
        fs.unlinkSync(path.join(work, name));
      } catch {
        // déjà absent
      }
    }
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ─── Suites API ─────────────────────────────────────────────────────────────

async function apiJest(
  label,
  args,
  { allowTestOwnedEnv = false, timeZone = null } = {},
) {
  for (const prefix of TEST_OWNED_ENV_PREFIXES) {
    if (path.resolve(prefix).startsWith(path.resolve(C.REPO))) {
      throw new Error('Exception de garde refusée : préfixe sous le dépôt');
    }
  }
  const log = newLog(label);
  const started = Date.now();
  const code = await run(process.execPath, [JEST_BIN, ...args], {
    cwd: C.API_DIR,
    env: isolatedEnv(log.file, {
      ...(allowTestOwnedEnv
        ? {
            RECIPE_ENV_GUARD_ALLOW_PREFIXES: TEST_OWNED_ENV_PREFIXES.join(
              path.delimiter,
            ),
          }
        : {}),
      // 1-16D : fuseau explicite (`--tz=`), seule variable ajoutée.
      ...(timeZone ? { TZ: timeZone } : {}),
    }),
  });
  const entries = readLog(log.file);
  const report = {
    label,
    exit: code,
    ...(timeZone ? { timeZone } : {}),
    seconds: Math.round((Date.now() - started) / 1000),
    guardedProcesses: new Set(entries.map((e) => e.pid)).size,
    blockedAttempts: summarize(entries),
    guardLog: log.file,
  };
  return report;
}

// ─── Build web (copie isolée) ───────────────────────────────────────────────

async function webBuild() {
  if (C.readState()) {
    throw new Error(
      'Une recette utilise la copie isolée : arrêter la recette avant.',
    );
  }
  const log = newLog('web');
  const copy = prepareIsolatedWeb(
    C.WEB_DIR,
    C.WEB_COPY_DIR,
    path.join(C.WEB_DIR, 'node_modules'),
  );
  try {
    const envInCopy = findEnvFiles(C.WEB_COPY_DIR);
    if (envInCopy.length > 0)
      throw new Error('.env* présent dans la copie isolée');
    const code = await run(process.execPath, [NEXT_BIN, 'build'], {
      cwd: C.WEB_COPY_DIR,
      // Valeurs publiques fictives de la recette ; aucun `.env*` disponible.
      env: isolatedEnv(log.file, {
        NODE_ENV: 'production',
        NEXT_PUBLIC_API_URL: C.API_URL,
        NEXT_PUBLIC_REGISTRATION_ENABLED: 'true',
        NEXT_TELEMETRY_DISABLED: '1',
      }),
    });
    const entries = readLog(log.file);
    return {
      label: 'web-build',
      exit: code,
      copy: C.WEB_COPY_DIR,
      excludedEnvFilesByName: copy.excludedEnvFiles.length,
      envFilesInCopy: envInCopy.length,
      blockedAttempts: summarize(entries),
      guardLog: log.file,
    };
  } finally {
    removeIsolatedWeb(C.WEB_COPY_DIR);
  }
}

/** 1-15D — motifs de chemins de tests : caractères de chemin uniquement. */
/**
 * 1-16D — `--tz=<nom IANA>` : fuseau du processus Jest, fixé AU LANCEMENT
 * (le `process.env` d'un test Jest est une copie : l'affecter ne change pas
 * l'heure locale). Nom validé ; aucune autre variable n'est ajoutée.
 */
function splitTimeZone(args) {
  const rest = [];
  let timeZone = null;
  for (const a of args) {
    const m = /^--tz=(.+)$/.exec(a);
    if (!m) {
      rest.push(a);
      continue;
    }
    if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(m[1])) {
      throw new Error(`Fuseau refusé : ${m[1]}`);
    }
    new Intl.DateTimeFormat('en-US', { timeZone: m[1] }); // RangeError si inconnu
    timeZone = m[1];
  }
  return { rest, timeZone };
}

function testPatterns(patterns) {
  for (const p of patterns) {
    if (!/^[\w./-]+$/.test(p)) throw new Error(`Motif de test refusé : ${p}`);
  }
  return patterns;
}

async function main(what, args = []) {
  const { rest: patterns, timeZone } = splitTimeZone(args);
  switch (what) {
    case 'selftest': {
      const r = await selftest();
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      return r.pass ? 0 : 1;
    }
    case 'api-unit': {
      const r = await apiJest('api-unit', testPatterns(patterns), {
        timeZone,
      });
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      return r.exit;
    }
    case 'api-e2e': {
      const r = await apiJest(
        'api-e2e',
        [
          '--config',
          './test/jest-e2e.json',
          '--maxWorkers=1',
          ...testPatterns(patterns),
        ],
        { allowTestOwnedEnv: true, timeZone },
      );
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      return r.exit;
    }
    case 'web-build': {
      const r = await webBuild();
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      return r.exit;
    }
    default:
      process.stdout.write('isolated selftest|api-unit|api-e2e|web-build\n');
      return 2;
  }
}

module.exports = { main };
