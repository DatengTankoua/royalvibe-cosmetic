#!/usr/bin/env node
/**
 * 1-20A — Stack de charge STRICTEMENT LOCALE (TEST).
 *
 *   node api/test/load/load-stack.js start [--profile=current|large]
 *   node api/test/load/load-stack.js status | stop | restart-api
 *   node api/test/load/load-stack.js mark <phase>      (étiquette des mesures)
 *
 * Ordre : contrôles préalables → `MongoMemoryReplSet` (127.0.0.1, port
 * aléatoire, cache WiredTiger borné) → 9 migrations de pré-déploiement
 * (`PREDEPLOY_MIGRATIONS` de dist, comme Railway) → peuplement déterministe
 * et sessions → stockage objet simulé → API compilée (`load-api.js`, tas
 * borné) → abonnements push fictifs (route réelle) → échantillonneurs.
 *
 * Échantillonneurs (toutes les 2 s) : `serverStatus` MongoDB (connexions,
 * latences, transactions, cache), travaux de notification en attente et leur
 * ancienneté, CPU/RAM des processus API, mongod et k6 (générateur), mémoire
 * libre de la machine.
 *
 * Nettoyage (succès, erreur, Ctrl+C, `stop`) : SEULS les processus lancés
 * ici, instance MongoDB (données supprimées), répertoire d'état.
 */
'use strict';

require('../recipe/preload.cjs');
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const L = require('./load-common');

const { R } = L;
const IS_WINDOWS = process.platform === 'win32';
const say = (line) => process.stdout.write(`[charge] ${line}\n`);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const children = new Set();

function startChild(name, command, args, { cwd, env }) {
  const logPath = path.join(L.LOG_DIR, `${name}.log`);
  const log = fs.createWriteStream(logPath, { flags: 'a' });
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: !IS_WINDOWS,
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.logPath = logPath;
  child.output = '';
  const capture = (chunk) => {
    child.output = (child.output + chunk).slice(-50_000);
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

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
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

async function run(name, command, args, options) {
  const child = startChild(name, command, args, options);
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(
      `${name} a échoué (code ${code}).\n${child.output.slice(-3000)}`,
    );
  }
  return child.output;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: L.HOST, port });
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

// ─── Échantillonneurs ────────────────────────────────────────────────────────

function currentPhase() {
  try {
    return fs.readFileSync(L.PHASE_FILE, 'utf8').trim() || 'idle';
  } catch {
    return 'idle';
  }
}

function append(file, line) {
  try {
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
  } catch {
    // mesure facultative
  }
}

/** `serverStatus` + travaux de notification en attente (lecture seule). */
function startDbSampler(stack) {
  const { MongoClient } = R.apiRequire('mongoose').mongo;
  const client = new MongoClient(stack.uri, { maxPoolSize: 2 });
  let previous = null;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const db = client.db(L.DB_NAME);
      const s = await db.admin().command({ serverStatus: 1 });
      const now = new Date();
      const [pendingJobs, oldestJob, dueDeliveries, oldestDelivery] =
        await Promise.all([
          db.collection('push_jobs').countDocuments({ status: 'pending' }),
          db
            .collection('push_jobs')
            .find({ status: 'pending' })
            .sort({ createdAt: 1 })
            .limit(1)
            .project({ createdAt: 1 })
            .toArray(),
          db.collection('push_deliveries').countDocuments({
            status: 'pending',
            nextAttemptAt: { $lte: now },
          }),
          db
            .collection('push_deliveries')
            .find({ status: 'pending', nextAttemptAt: { $lte: now } })
            .sort({ nextAttemptAt: 1 })
            .limit(1)
            .project({ nextAttemptAt: 1 })
            .toArray(),
        ]);
      const lat = s.opLatencies;
      const cur = {
        t: Date.now(),
        reads: lat.reads,
        writes: lat.writes,
        commands: lat.commands,
        tx: s.transactions,
        op: s.opcounters,
      };
      const delta = (k) => {
        if (!previous) return null;
        const ops = cur[k].ops - previous[k].ops;
        const us = cur[k].latency - previous[k].latency;
        return { ops, avgMs: ops > 0 ? Math.round(us / ops / 10) / 100 : 0 };
      };
      const cache = s.wiredTiger && s.wiredTiger.cache;
      append(L.METRICS_DB, {
        t: cur.t,
        phase: currentPhase(),
        connections: s.connections.current,
        reads: delta('reads'),
        writes: delta('writes'),
        commands: delta('commands'),
        txCommitted: previous
          ? cur.tx.totalCommitted - previous.tx.totalCommitted
          : null,
        txAborted: previous
          ? cur.tx.totalAborted - previous.tx.totalAborted
          : null,
        txActive: cur.tx.currentActive,
        cacheMb: cache
          ? Math.round(cache['bytes currently in the cache'] / 2 ** 20)
          : null,
        cacheMaxMb: cache
          ? Math.round(cache['maximum bytes configured'] / 2 ** 20)
          : null,
        residentMb: s.mem && s.mem.resident,
        pendingJobs,
        oldestPendingJobAgeS: oldestJob[0]
          ? Math.round((now - oldestJob[0].createdAt) / 1000)
          : 0,
        dueDeliveries,
        oldestDueDeliveryLateS: oldestDelivery[0]
          ? Math.round((now - oldestDelivery[0].nextAttemptAt) / 1000)
          : 0,
      });
      previous = cur;
    } catch (error) {
      append(L.METRICS_DB, { t: Date.now(), error: error.message });
    }
    if (!stopped) setTimeout(tick, 2000).unref();
  };
  void client.connect().then(tick);
  return async () => {
    stopped = true;
    await client.close().catch(() => undefined);
  };
}

/**
 * CPU et mémoire des processus (API, mongod, k6) par un seul PowerShell
 * long : temps CPU cumulé → cœurs utilisés sur l'intervalle.
 */
function startProcSampler(stack) {
  if (!IS_WINDOWS) return () => undefined;
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $ids = (Get-Content -Raw '${path.join(L.STATE_DIR, 'pids.json')}' | ConvertFrom-Json)
  $rows = @()
  foreach ($p in @(Get-Process -Id $ids.api, $ids.mongod) + @(Get-Process -Name k6)) {
    if ($p) { $rows += @{ id = $p.Id; name = $p.ProcessName; cpu = $p.CPU; ws = $p.WorkingSet64; pm = $p.PrivateMemorySize64 } }
  }
  $os = Get-CimInstance Win32_OperatingSystem
  @{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); freeMb = [int]($os.FreePhysicalMemory / 1024); rows = $rows } | ConvertTo-Json -Compress -Depth 4
  Start-Sleep -Seconds 2
}`;
  const child = spawn(
    'pwsh',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    },
  );
  children.add(child);
  let buffer = '';
  const previous = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        const sample = JSON.parse(line);
        const rows = Array.isArray(sample.rows) ? sample.rows : [sample.rows];
        const out = {
          t: sample.t,
          phase: currentPhase(),
          freeMb: sample.freeMb,
        };
        for (const row of rows.filter(Boolean)) {
          const label =
            row.id === stack.api?.pid
              ? 'api'
              : row.id === stack.mongodPid
                ? 'mongod'
                : row.name === 'k6'
                  ? 'k6'
                  : row.name;
          const prev = previous.get(row.id);
          const cores =
            prev && sample.t > prev.t
              ? Math.round(
                  ((row.cpu - prev.cpu) / ((sample.t - prev.t) / 1000)) * 100,
                ) / 100
              : null;
          previous.set(row.id, { t: sample.t, cpu: row.cpu });
          out[label] = {
            cores,
            wsMb: Math.round(row.ws / 2 ** 20),
            privateMb: Math.round(row.pm / 2 ** 20),
          };
        }
        append(L.METRICS_PROC, out);
      } catch {
        // ligne incomplète
      }
    }
  });
  return () => killTree(child);
}

// ─── Abonnements push fictifs (route réelle) ─────────────────────────────────

async function registerPushDevices() {
  const { sessions } = L.readJson(L.SESSIONS_FILE);
  let registered = 0;
  for (const s of sessions.filter((x) => x.role !== 'seller')) {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const response = await L.api('POST', '/notifications/push/subscription', {
      token: s.token,
      body: {
        subscription: {
          endpoint: `https://fcm.googleapis.com/fcm/send/charge-${crypto.randomBytes(12).toString('hex')}`,
          keys: {
            p256dh: ecdh.getPublicKey().toString('base64url'),
            auth: crypto.randomBytes(16).toString('base64url'),
          },
        },
      },
    });
    if (response.status !== 200)
      throw new Error(`Abonnement push refusé (${response.status}).`);
    registered += 1;
  }
  return registered;
}

// ─── Stack ───────────────────────────────────────────────────────────────────

async function start(options) {
  const profile = options.profile || 'current';
  // 1-20B : `--dist=<dossier sous api/>` (témoin de l'ancien code).
  if (options.dist) process.env.LOAD_DIST = path.resolve(options.dist);
  const distUsed = L.distDir();
  if (!L.PROFILES[profile])
    throw new Error(`--profile : ${Object.keys(L.PROFILES).join(' | ')}`);
  const existing = L.readJson(L.STATE_FILE);
  if (existing && R.isAlive(existing.launcherPid))
    throw new Error(`Stack déjà en cours (lanceur ${existing.launcherPid}).`);
  if (!fs.existsSync(path.join(L.distDir(), 'main.js')))
    throw new Error('api/dist absent : pnpm --filter api build');
  for (const [name, port] of Object.entries(L.PORTS)) {
    if (await portInUse(port))
      throw new Error(
        `Port ${port} (${name}) occupé : aucun processus arrêté.`,
      );
  }
  fs.rmSync(L.STATE_DIR, { recursive: true, force: true });
  fs.mkdirSync(L.LOG_DIR, { recursive: true });
  fs.mkdirSync(L.WORK_DIR, { recursive: true });
  fs.writeFileSync(L.PHASE_FILE, 'setup');

  const stack = {
    profile,
    replSet: null,
    uri: null,
    api: null,
    mongodPid: null,
    stoppers: [],
    stopping: null,
    startedAt: new Date().toISOString(),
  };
  const writeState = () => {
    fs.writeFileSync(
      L.STATE_FILE,
      JSON.stringify(
        {
          launcherPid: process.pid,
          profile,
          mongodbUri: stack.uri,
          apiUrl: L.API_URL,
          apiPid: stack.api && stack.api.pid,
          mongodPid: stack.mongodPid,
          seed: stack.seed,
          limits: L.LIMITS,
          dist: path.relative(R.API_DIR, distUsed),
          versions: stack.versions,
          startedAt: stack.startedAt,
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(L.STATE_DIR, 'pids.json'),
      JSON.stringify({
        api: stack.api ? stack.api.pid : 0,
        mongod: stack.mongodPid || 0,
      }),
    );
  };

  const startApi = async () => {
    stack.api = startChild(
      'api',
      process.execPath,
      [
        `--max-old-space-size=${L.LIMITS.apiHeapMb}`,
        path.join(__dirname, 'load-api.js'),
      ],
      {
        cwd: L.WORK_DIR,
        env: L.apiEnv(stack.uri, { LOAD_LAUNCHED: '1' }),
      },
    );
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (stack.api.exitCode !== null)
        throw new Error(`API arrêtée.\n${stack.api.output.slice(-3000)}`);
      if (/API READY/.test(stack.api.output)) {
        try {
          const r = await fetch(`${L.API_URL}/health`);
          if (r.status === 200) return;
        } catch {
          // pas encore prête
        }
      }
      await delay(250);
    }
    throw new Error('API : délai de démarrage dépassé.');
  };
  stack.restartApi = async () => {
    await stopChild(stack.api);
    const t = Date.now();
    await startApi();
    writeState();
    return { apiPid: stack.api.pid, restartMs: Date.now() - t };
  };

  stack.shutdown = (reason, code = 0) => {
    if (stack.stopping) return stack.stopping;
    stack.stopping = (async () => {
      say(`nettoyage (${reason}) …`);
      for (const stop of stack.stoppers) await stop();
      for (const child of [stack.api, ...children]) await stopChild(child);
      if (stack.control)
        await new Promise((r) => stack.control.close(() => r()));
      if (stack.storage)
        await new Promise((r) => stack.storage.close(() => r()));
      if (stack.replSet) {
        try {
          await stack.replSet.stop({ doCleanup: true, force: true });
        } catch {
          // déjà arrêtée
        }
      }
      if (options.keepState) {
        fs.rmSync(L.STATE_FILE, { force: true });
        say(`état conservé : ${L.STATE_DIR}`);
      } else {
        fs.rmSync(L.STATE_DIR, { recursive: true, force: true });
      }
      say(`terminé (${reason}).`);
      process.exit(code);
    })();
    return stack.stopping;
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'])
    process.on(signal, () => void stack.shutdown(`signal ${signal}`, 130));
  process.on('exit', () => {
    for (const child of children) killTree(child);
  });

  try {
    say(
      `MongoDB éphémère (127.0.0.1, cache WiredTiger ${L.LIMITS.wiredTigerCacheGb} Go) …`,
    );
    const { MongoMemoryReplSet } = R.apiRequire('mongodb-memory-server');
    stack.replSet = new MongoMemoryReplSet({
      binary: { version: R.MONGODB_BINARY_VERSION },
      instanceOpts: [
        {
          ip: L.HOST,
          args: ['--wiredTigerCacheSizeGB', String(L.LIMITS.wiredTigerCacheGb)],
        },
      ],
      replSet: { count: 1, dbName: L.DB_NAME, storageEngine: 'wiredTiger' },
    });
    await stack.replSet.start();
    await stack.replSet.waitUntilRunning();
    stack.uri = L.assertLoadUri(stack.replSet.getUri(L.DB_NAME));
    try {
      stack.mongodPid =
        stack.replSet.servers[0].instanceInfo.instance.mongodProcess.pid;
    } catch {
      stack.mongodPid = null;
    }
    stack.versions = {
      node: process.version,
      mongodb: R.MONGODB_BINARY_VERSION,
      k6: null,
    };
    writeState();

    const { PREDEPLOY_MIGRATIONS } = L.dist('migrations/predeploy-migrations');
    for (const migration of PREDEPLOY_MIGRATIONS) {
      say(`migration ${migration}`);
      await run(
        `migration-${migration.replace(/\.js$/, '')}`,
        process.execPath,
        [path.join(L.distDir(), 'migrations', migration)],
        { cwd: L.WORK_DIR, env: L.apiEnv(stack.uri) },
      );
    }

    say(`peuplement déterministe (profil ${profile}) et sessions …`);
    const output = await run(
      'seed',
      process.execPath,
      [path.join(__dirname, 'load-seed.js')],
      {
        cwd: L.WORK_DIR,
        env: L.apiEnv(stack.uri, { LOAD_LAUNCHED: '1', LOAD_PROFILE: profile }),
      },
    );
    const line = output.split('\n').find((l) => l.startsWith('SEED '));
    if (!line) throw new Error('peuplement : sortie absente.');
    stack.seed = JSON.parse(line.slice(5));
    say(`peuplement : ${JSON.stringify(stack.seed)}`);

    stack.storage =
      await require('../recipe/storage-sim').startStorageSimulator({
        host: L.HOST,
        port: L.PORTS.storage,
        bucket: L.STORAGE_BUCKET,
      });
    stack.control = await startControlServer(stack);
    say('API compilée (load-api.js) …');
    await startApi();
    writeState();
    stack.pushDevices = await registerPushDevices();
    say(`abonnements push fictifs : ${stack.pushDevices}`);
    stack.stoppers.push(startDbSampler(stack));
    stack.stoppers.push(startProcSampler(stack));
    fs.writeFileSync(L.PHASE_FILE, 'idle');
    writeState();
    say(`PRÊTE — API ${L.API_URL} ; état ${L.STATE_DIR}`);
    say('Arrêt : Ctrl+C, ou node api/test/load/load-stack.js stop');
  } catch (error) {
    say(`ÉCHEC : ${error.message}`);
    await stack.shutdown('erreur au démarrage', 1);
  }
}

function startControlServer(stack) {
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (
      req.headers.origin !== undefined ||
      req.headers.host !== `${L.HOST}:${L.PORTS.control}`
    )
      return send(403, { error: 'forbidden' });
    try {
      switch (`${req.method} ${req.url}`) {
        case 'GET /state':
          return send(200, L.readJson(L.STATE_FILE));
        case 'POST /restart-api':
          return send(200, await stack.restartApi());
        case 'POST /stop':
          send(200, { stopping: true });
          setImmediate(() => stack.shutdown('arrêt demandé'));
          return undefined;
        default:
          return send(404, { error: 'route inconnue' });
      }
    } catch (error) {
      return send(500, { error: error.message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(L.PORTS.control, L.HOST, () => resolve(server));
  });
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = {};
  const positional = [];
  for (const arg of rest) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (m)
      options[m[1].replace(/-(.)/g, (_, c) => c.toUpperCase())] = m[2] ?? true;
    else positional.push(arg);
  }
  switch (command) {
    case 'start':
      return start(options);
    case 'status':
      return console.log(JSON.stringify(L.requireRunningState(), null, 2));
    case 'stop':
      L.requireRunningState();
      return console.log(JSON.stringify(await L.control('/stop', {})));
    case 'restart-api':
      L.requireRunningState();
      return console.log(JSON.stringify(await L.control('/restart-api', {})));
    case 'mark':
      L.requireRunningState();
      fs.writeFileSync(L.PHASE_FILE, positional[0] || 'idle');
      return console.log(`phase=${positional[0] || 'idle'}`);
    default:
      console.log(
        'Usage : load-stack.js start [--profile=current|large] [--keep-state] | status | stop | restart-api | mark <phase>',
      );
      return undefined;
  }
}

main().catch((error) => {
  console.error(`[charge] ${error.message}`);
  process.exit(1);
});
