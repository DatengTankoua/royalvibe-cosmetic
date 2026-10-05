/**
 * 1-14D.2H — Lanceur de la stack STRICTEMENT LOCALE de la recette (TEST).
 *
 * Ordre : contrôles préalables → copie web isolée (sans aucun `.env*`) et
 * build de production dans cette copie (API locale) →
 * `MongoMemoryReplSet` (127.0.0.1, port aléatoire) → 4 migrations explicites
 * → fixtures explicites → serveur de contrôle et simulateurs (127.0.0.1)
 * → API compilée (entrée de test) → serveur web (127.0.0.1).
 *
 * - La cible MongoDB est EXCLUSIVEMENT l'instance créée ici ; les enfants
 *   reçoivent un environnement construit (`recipe-common.js`), jamais celui
 *   de l'utilisateur, et la garde anti-`.env` est préchargée partout.
 * - Nettoyage après succès, erreur ou interruption : arrêt des SEULS
 *   processus lancés ici (et de leurs descendants), arrêt et suppression de
 *   l'instance MongoDB, suppression du répertoire d'état et de la copie web.
 * - Le build et `next start` s'exécutent dans la copie isolée
 *   (`web-copy.js`) : `web/` (ses `.env*`, son `.next`) n'est jamais le
 *   répertoire d'un processus Next de la recette.
 */
'use strict';

require('./preload.cjs');
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const C = require('./recipe-common');
const {
  SimulationState,
  providerInitiate,
  providerStatus,
  campayRoute,
} = require('./simulators');
const { ACCOUNTS } = require('./fixtures');
const { prepareIsolatedWeb, removeIsolatedWeb } = require('./web-copy');

const MIGRATIONS = [
  'create-sale-operations-index.js',
  'create-subscription-period-indexes.js',
  'create-subscription-payment-indexes.js',
  'create-subscription-payment-reconciliation-indexes.js',
];
const NEXT_BIN = path.join(
  C.WEB_DIR,
  'node_modules',
  'next',
  'dist',
  'bin',
  'next',
);
const IS_WINDOWS = process.platform === 'win32';

const say = (line) => process.stdout.write(`[recette] ${line}\n`);

// ─── Processus enfants ───────────────────────────────────────────────────────

const children = new Set();

function startChild(name, command, args, { cwd, env }) {
  const logPath = path.join(C.LOG_DIR, `${name}.log`);
  const log = fs.createWriteStream(logPath, { flags: 'a' });
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: !IS_WINDOWS, // groupe de processus dédié (POSIX)
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.logPath = logPath;
  child.output = '';
  const capture = (chunk) => {
    child.output = (child.output + chunk).slice(-20_000);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.exited = new Promise((resolve) =>
    child.once('exit', (code) => resolve(code)),
  );
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

/** Arrête un enfant ET ses descendants (seulement eux). */
function killTree(child) {
  if (
    !child ||
    child.exitCode !== null ||
    child.signalCode !== null ||
    !child.pid
  )
    return;
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // déjà terminé
    }
  }
}

async function stopChild(child) {
  if (!child) return;
  killTree(child);
  await Promise.race([child.exited, delay(10_000)]);
}

function tail(file, lines = 25) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

async function run(name, command, args, options) {
  const child = startChild(name, command, args, options);
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(`${name} a échoué (code ${code}).\n${tail(child.logPath)}`);
  }
  return child.output;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Disponibilité d'un serveur LANCÉ ICI : son propre marqueur de démarrage
 * (écoute réussie) est exigé en plus d'une réponse HTTP, pour ne jamais
 * prendre un processus tiers apparu sur le même port pour le nôtre.
 */
async function waitReady(child, marker, url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${label} s'est arrêté (code ${child.exitCode}).
${tail(child.logPath)}`);
    }
    if (/EADDRINUSE/.test(child.output)) {
      throw new Error(`${label} : port déjà utilisé par un autre processus (non arrêté).
${tail(child.logPath)}`);
    }
    if (marker.test(child.output)) {
      try {
        const response = await fetch(url, { redirect: 'manual' });
        if (response.status < 500) return;
      } catch {
        // pas encore prêt
      }
    }
    await delay(250);
  }
  throw new Error(`${label} : délai de démarrage dépassé.
${tail(child.logPath)}`);
}

// ─── Contrôles préalables ────────────────────────────────────────────────────

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: C.HOST, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function preflight() {
  const existing = C.readState();
  if (existing && C.isAlive(existing.launcherPid)) {
    throw new Error(
      `Une recette est déjà en cours (lanceur ${existing.launcherPid}). Arrêter : recipe.js stop`,
    );
  }
  for (const file of [
    'main.js',
    'app.module.js',
    ...MIGRATIONS.map((m) => `migrations/${m}`),
  ]) {
    if (!fs.existsSync(path.join(C.DIST, file))) {
      throw new Error(
        `api/dist incomplet (${file}). Lancer d'abord : pnpm --filter api build`,
      );
    }
  }
  if (!fs.existsSync(NEXT_BIN))
    throw new Error('Next.js introuvable dans web/node_modules.');
  for (const [name, port] of Object.entries(C.PORTS)) {
    if (await portInUse(port)) {
      throw new Error(
        `Port ${port} (${name}) déjà utilisé sur ${C.HOST} : aucun processus n'est arrêté, libérez-le.`,
      );
    }
  }
}

function resetStateDir() {
  // Répertoires PROPRES à la recette (noms fixes), y compris une copie web
  // laissée par un arrêt brutal précédent.
  fs.rmSync(C.STATE_DIR, { recursive: true, force: true });
  removeIsolatedWeb(C.WEB_COPY_DIR);
  fs.mkdirSync(C.LOG_DIR, { recursive: true });
  fs.mkdirSync(C.WORK_DIR, { recursive: true });
}

// ─── Build web (copie isolée) ────────────────────────────────────────────────

async function buildWeb() {
  say('copie web isolée (aucun .env*), puis build de production …');
  const copy = prepareIsolatedWeb(
    C.WEB_DIR,
    C.WEB_COPY_DIR,
    path.join(C.WEB_DIR, 'node_modules'),
  );
  await run('web-build', process.execPath, [NEXT_BIN, 'build'], {
    cwd: C.WEB_COPY_DIR,
    env: C.webEnv(),
  });
  return {
    directory: C.WEB_COPY_DIR,
    apiUrl: C.API_URL,
    excludedEnvFiles: copy.excludedEnvFiles.length,
    builtAt: new Date().toISOString(),
  };
}

// ─── Serveur de contrôle et simulateurs (127.0.0.1) ─────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('corps trop volumineux'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

function startControlServer(stack) {
  const sim = stack.sim;
  const allowedHosts = new Set([
    `${C.HOST}:${C.PORTS.control}`,
    `localhost:${C.PORTS.control}`,
  ]);
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(body));
    };
    // Aucune page web ne peut piloter la recette (pas d'Origin, hôte exact).
    if (
      req.headers.origin !== undefined ||
      !allowedHosts.has(req.headers.host)
    ) {
      return send(403, { error: 'forbidden' });
    }
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      return send(400, { error: error.message });
    }
    const url = new URL(req.url, C.CONTROL_URL);
    try {
      if (url.pathname.startsWith('/campay/')) {
        const reply = campayRoute(
          sim,
          req.method,
          url.pathname.slice('/campay'.length),
          req.headers,
          body,
        );
        if (reply.destroy) {
          req.socket.destroy(); // réponse PERDUE (la collecte peut exister)
          return undefined;
        }
        return send(reply.status, reply.body);
      }
      switch (`${req.method} ${url.pathname}`) {
        case 'GET /state':
          return send(200, stack.publicState());
        case 'POST /api/restart':
          return send(200, await stack.restartApi(body.provider));
        case 'POST /stop':
          send(200, { stopping: true });
          setImmediate(() => stack.shutdown('arrêt demandé (recipe.js stop)'));
          return undefined;
        case 'POST /sim/reset':
          sim.reset();
          return send(200, { ok: true });
        case 'GET /sim/stats':
          return send(200, sim.stats());
        case 'POST /sim/queue-init':
          sim.queueInit(body.behaviors || []);
          return send(200, { ok: true });
        case 'POST /sim/queue-status':
          sim.queueStatus(body.behaviors || []);
          return send(200, { ok: true });
        case 'POST /sim/settle': {
          const tx = sim.settle(body.reference, body.state);
          return tx
            ? send(200, { ok: true, transaction: tx })
            : send(404, { ok: false, error: 'transaction inconnue' });
        }
        case 'POST /sim/provider/initiate':
          return send(200, providerInitiate(sim, body));
        case 'POST /sim/provider/status':
          return send(200, providerStatus(sim, body));
        default:
          return send(404, { error: 'route inconnue' });
      }
    } catch (error) {
      return send(400, { error: error.message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(C.PORTS.control, C.HOST, () => resolve(server));
  });
}

// ─── Stack ───────────────────────────────────────────────────────────────────

async function start(options) {
  const provider = options.provider || 'simulated';
  if (!C.PROVIDERS.includes(provider))
    throw new Error(`--provider : ${C.PROVIDERS.join(' | ')}`);
  await preflight();
  resetStateDir();

  const stack = {
    sim: new SimulationState(),
    provider,
    replSet: null,
    uri: null,
    api: null,
    web: null,
    control: null,
    fixtures: null,
    webBuild: null,
    stopping: null,
    restarting: Promise.resolve(),
    startedAt: new Date().toISOString(),
  };

  stack.publicState = () => ({
    launcherPid: process.pid,
    provider: stack.provider,
    mongodbUri: stack.uri,
    urls: {
      web: C.WEB_ORIGIN,
      api: C.API_URL,
      control: C.CONTROL_URL,
      storage: C.STORAGE_URL,
    },
    apiPid: stack.api && stack.api.pid,
    webPid: stack.web && stack.web.pid,
    webBuild: stack.webBuild,
    fixtures: stack.fixtures,
    startedAt: stack.startedAt,
    stateDir: C.STATE_DIR,
  });
  const writeState = () =>
    fs.writeFileSync(
      C.STATE_FILE,
      JSON.stringify(stack.publicState(), null, 2),
    );

  const startApi = async () => {
    const env = C.apiEnv(stack.uri, {
      RECIPE_PROVIDER: stack.provider,
      RECIPE_LAUNCHED: '1',
    });
    stack.api = startChild(
      'api',
      process.execPath,
      [path.join(__dirname, 'boot-api.js')],
      { cwd: C.WORK_DIR, env },
    );
    await waitReady(
      stack.api,
      /API READY/,
      `${C.API_URL}/health`,
      60_000,
      'API',
    );
  };

  stack.restartApi = (nextProvider) => {
    const job = stack.restarting.then(async () => {
      if (nextProvider !== undefined) {
        if (!C.PROVIDERS.includes(nextProvider))
          throw new Error(`provider : ${C.PROVIDERS.join(' | ')}`);
        stack.provider = nextProvider;
      }
      await stopChild(stack.api);
      await startApi();
      writeState();
      return { provider: stack.provider, apiPid: stack.api.pid };
    });
    stack.restarting = job.catch(() => undefined);
    return job;
  };

  stack.shutdown = (reason, code = 0) => {
    if (stack.stopping) return stack.stopping;
    stack.stopping = (async () => {
      say(`nettoyage (${reason}) …`);
      for (const child of [stack.web, stack.api, ...children])
        await stopChild(child);
      if (stack.control)
        await new Promise((resolve) => stack.control.close(() => resolve()));
      if (stack.storage)
        await new Promise((resolve) => stack.storage.close(() => resolve()));
      if (stack.replSet) {
        try {
          await stack.replSet.stop({ doCleanup: true, force: true });
        } catch {
          // instance déjà arrêtée
        }
      }
      try {
        removeIsolatedWeb(C.WEB_COPY_DIR);
      } catch (error) {
        say(
          `copie web non supprimée (${error.code || error.message}) : ${C.WEB_COPY_DIR}`,
        );
      }
      if (options.keepLogs) {
        fs.rmSync(C.STATE_FILE, { force: true });
        fs.rmSync(C.WORK_DIR, { recursive: true, force: true });
        say(`journaux conservés : ${C.LOG_DIR}`);
      } else {
        fs.rmSync(C.STATE_DIR, { recursive: true, force: true });
      }
      say(`terminé (${reason}).`);
      process.exit(code);
    })();
    return stack.stopping;
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(signal, () => void stack.shutdown(`signal ${signal}`, 130));
  }
  process.on('exit', () => {
    // Dernier recours synchrone (arrêt brutal du nettoyage asynchrone).
    for (const child of children) killTree(child);
  });

  try {
    stack.webBuild = await buildWeb();

    say('MongoDB éphémère (MongoMemoryReplSet, 127.0.0.1) …');
    const { MongoMemoryReplSet } = C.apiRequire('mongodb-memory-server');
    stack.replSet = new MongoMemoryReplSet({
      binary: { version: C.MONGODB_BINARY_VERSION },
      instanceOpts: [{ ip: C.HOST }],
      replSet: { count: 1, dbName: C.DB_NAME, storageEngine: 'wiredTiger' },
    });
    await stack.replSet.start();
    await stack.replSet.waitUntilRunning();
    stack.uri = C.assertRecipeUri(stack.replSet.getUri(C.DB_NAME));
    writeState();

    for (const migration of MIGRATIONS) {
      say(`migration ${migration}`);
      await run(
        `migration-${migration.replace(/\.js$/, '')}`,
        process.execPath,
        [path.join(C.DIST, 'migrations', migration)],
        {
          cwd: C.WORK_DIR,
          env: C.apiEnv(stack.uri),
        },
      );
    }

    say('fixtures explicites (schéma et comptes fictifs) …');
    const output = await run(
      'fixtures',
      process.execPath,
      [path.join(__dirname, 'seed-fixtures.js')],
      {
        cwd: C.WORK_DIR,
        env: C.apiEnv(stack.uri, { RECIPE_LAUNCHED: '1' }),
      },
    );
    const line = output.split('\n').find((l) => l.startsWith('FIXTURES '));
    if (!line) throw new Error('fixtures : sortie absente.');
    stack.fixtures = JSON.parse(line.slice('FIXTURES '.length));

    stack.control = await startControlServer(stack);
    // 1-15C : stockage objet simulé (logos), en mémoire, boucle locale.
    stack.storage = await require('./storage-sim').startStorageSimulator({
      host: C.HOST,
      port: C.PORTS.storage,
      bucket: 'recipe-fictitious',
    });
    say(`API compilée (fournisseur ${stack.provider}) …`);
    await startApi();

    say('serveur web de production …');
    stack.web = startChild(
      'web',
      process.execPath,
      [NEXT_BIN, 'start', '-H', C.HOST, '-p', String(C.PORTS.web)],
      {
        cwd: C.WEB_COPY_DIR,
        env: C.webEnv({ PORT: String(C.PORTS.web) }),
      },
    );
    await waitReady(
      stack.web,
      /Ready in/,
      `${C.WEB_ORIGIN}/auth/login`,
      60_000,
      'Web',
    );
    writeState();
    printSummary(stack);
    return stack;
  } catch (error) {
    say(`ÉCHEC : ${error.message}`);
    await stack.shutdown('erreur au démarrage', 1);
    return stack;
  }
}

function printSummary(stack) {
  const lines = [
    '',
    'RECETTE LOCALE PRÊTE — tout est fictif ; aucun appel CamPay réel.',
    `  Web        ${C.WEB_ORIGIN}/auth/login`,
    `  API        ${C.API_URL}   (fournisseur : ${stack.provider})`,
    `  Contrôle   ${C.CONTROL_URL}   (simulateurs, 127.0.0.1 uniquement)`,
    `  MongoDB    éphémère, base ${C.DB_NAME} (127.0.0.1, port ${new URL(stack.uri).port})`,
    `  Mot de passe des comptes : ${C.PASSWORD}`,
    ...ACCOUNTS.map(
      (a) => `    ${a.email.padEnd(42)} ${a.role.padEnd(7)} ${a.use}`,
    ),
    '',
    '  Autre terminal : node api/test/recipe/recipe.js help',
    '  Arrêt : Ctrl+C ici, ou node api/test/recipe/recipe.js stop',
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

module.exports = { start };
