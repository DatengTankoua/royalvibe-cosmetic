#!/usr/bin/env node
/**
 * 1-14D.2H — Point d'entrée de la recette locale des paiements (TEST).
 * Usage : node api/test/recipe/recipe.js help
 */
'use strict';

require('./preload.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const C = require('./recipe-common');
const D = require('./db-tools');
const { ACCOUNTS } = require('./fixtures');
const A = require('./actions');

const HELP = `Recette locale des paiements (1-14D.2H) — tout est fictif, aucun appel CamPay réel.

Stack (terminal 1, reste au premier plan ; Ctrl+C nettoie) :
  start [--provider=simulated|campay] [--keep-logs]

Pilotage (terminal 2, recette démarrée) :
  status                          état, URLs, fournisseur
  stop                            arrêt et nettoyage complets
  provider simulated|campay       redémarre l'API avec ce fournisseur (base conservée)
  restart-api                     redémarre l'API (compteurs de limitation remis à zéro)
  accounts                        comptes fictifs et mot de passe
  owner --label=<x> [--expired]   nouveau propriétaire (inscription + vérification via l'API)
  expire --email=<e>              expiration de l'abonnement (écriture de test)
  org suspend|reactivate --email=<e>   suspension (écriture de test)
  payments [--email=<e>]          paiements, périodes « payment », audits de rapprochement
  sim stats|reset|transactions
  sim settle --reference=<réf. marchand ou prestataire> --state=succeeded|failed|pending
  sim queue-init accept|reject|unavailable|lost|uncertain-not-created ...
  sim queue-status normal|unavailable|not-found|override:<champ>=<valeur> ...
  webhook --payment-id=<id> [--status=SUCCESSFUL|FAILED] [--wrong-key]   POST signé (clé FICTIVE)
  webhook --replay                rejoue exactement la dernière notification
  reconcile-sim <arguments du CLI D.2G>   rapprochement SIMULÉ (faux CamPay local)
  real-cli <arguments du CLI D.2G>        VRAI CLI (fournisseur indisponible : simulation bloquée)

Campagne navigateur (stack démarrée en mode simulated) :
  scenarios [ids...] --playwright=<dossier contenant node_modules/playwright> [--chromium=<chrome.exe>] [--out=<dossier>]
  realtime [RT1..RT33] (mêmes options)    temps réel 1-15A/B/C/D/F : collègues, organisations, droits, coupure, outbox, analyse, corbeille, sections, purge, membres, invitations, image de marque, historique après purge, abonnement et paiements

Contrôles d'isolement (.env) :
  isolated selftest               auto-test Jest : .env factices, garde, témoin sans garde
  isolated api-unit|api-e2e [motifs]  suites API (jest) isolées des .env réels
  isolated web-build              next build dans la copie isolée (recette arrêtée)
  env-guard-selftest              garde JavaScript (canaris, témoin sans garde)
  web-canary-check [--out=<f>]    vrai next build / next start avec canaris (témoin, garde, copie isolée)
`;

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (const arg of args) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (match) flags[match[1]] = match[2] === undefined ? true : match[2];
    else rest.push(arg);
  }
  return { flags, rest };
}

const print = (value) =>
  process.stdout.write(
    `${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`,
  );

async function withDb(fn) {
  const state = C.requireRunningState();
  const connection = await D.connect(state.mongodbUri);
  try {
    return await fn(connection.db, state);
  } finally {
    await connection.close();
  }
}

/** Nouveau propriétaire par les routes publiques (inscription + vérification). */
async function createOwner(label, expired) {
  C.requireRunningState();
  const owner = await A.registerOwner(label);
  if (expired) await withDb((db) => D.expireOrganization(db, owner.orgId));
  return {
    email: owner.email,
    password: C.PASSWORD,
    userId: owner.userId,
    organizationId: owner.orgId,
    expired: Boolean(expired),
  };
}

function ownerOrganization(info) {
  const owner = info.memberships.find((m) => m.role === 'owner');
  if (!owner)
    throw new Error(`${info.email} n'est propriétaire d'aucune organisation.`);
  return owner.organizationId;
}

function parseStatusBehavior(token) {
  if (!token.startsWith('override:')) return token;
  const override = {};
  for (const pair of token.slice('override:'.length).split(',')) {
    const [key, value] = pair.split('=');
    override[key] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  }
  return { override };
}

// ─── Webhook signé (clé FICTIVE) ─────────────────────────────────────────────

const LAST_WEBHOOK = path.join(C.STATE_DIR, 'last-webhook.json');

async function webhook(flags) {
  C.requireRunningState();
  if (flags.replay) {
    if (!fs.existsSync(LAST_WEBHOOK))
      throw new Error('Aucune notification à rejouer.');
    return {
      replay: true,
      response: await A.postNotification(fs.readFileSync(LAST_WEBHOOK, 'utf8')),
    };
  }
  if (typeof flags['payment-id'] !== 'string')
    throw new Error('--payment-id requis.');
  const payment = await withDb((db) =>
    db
      .collection('subscription_payments')
      .findOne({ _id: D.oid(flags['payment-id']) }),
  );
  if (!payment) throw new Error('Paiement introuvable.');
  const text = A.buildNotification(payment, {
    status: flags.status || 'SUCCESSFUL',
    wrongKey: Boolean(flags['wrong-key']),
  });
  fs.writeFileSync(LAST_WEBHOOK, text);
  const sent = JSON.parse(text);
  return {
    sent: { ...sent, signature: `${sent.signature.slice(0, 12)}…` },
    response: await A.postNotification(text),
  };
}

// ─── Processus enfants (CLI, scénarios) ─────────────────────────────────────

function runInherited(script, args, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('exit', (code) => resolve(code === null ? 1 : code));
  });
}

function envGuardSelftest() {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'stockmaster-recipe-envguard-'),
  );
  const log = path.join(dir, 'guard.jsonl');
  const canaries = [
    '.env',
    '.env.local',
    '.env.production',
    '.env.production.local',
  ];
  try {
    for (const name of canaries) {
      fs.writeFileSync(
        path.join(dir, name),
        'RECIPE_CANARY=leaked\nNEXT_PUBLIC_RECIPE_CANARY=leaked\n',
      );
    }
    const nextDir = path.dirname(
      require.resolve('next/package.json', { paths: [C.WEB_DIR] }),
    );
    const nextEnv = require.resolve('@next/env', { paths: [nextDir] });
    const nestConfig = require.resolve('@nestjs/config', {
      paths: [C.API_DIR],
    });
    const dotenv = require.resolve('dotenv', {
      paths: [path.dirname(nestConfig)],
    });
    const probe = `
      (async () => {
        const dir = ${JSON.stringify(dir)};
        const out = {};
        require(${JSON.stringify(nextEnv)}).loadEnvConfig(dir, false, { info() {}, error() {} });
        out.nextEnv = process.env.RECIPE_CANARY || null; delete process.env.RECIPE_CANARY;
        require(${JSON.stringify(dotenv)}).config({ path: require('path').join(dir, '.env'), quiet: true });
        out.dotenv = process.env.RECIPE_CANARY || null; delete process.env.RECIPE_CANARY;
        await require(${JSON.stringify(nestConfig)}).ConfigModule.forRoot({ envFilePath: require('path').join(dir, '.env') });
        out.nestConfig = process.env.RECIPE_CANARY || null;
        process.stdout.write(JSON.stringify(out));
      })();`;
    const runProbe = (guarded) => {
      const env = C.baseEnv({ RECIPE_ENV_GUARD_LOG: log });
      if (!guarded) delete env.NODE_OPTIONS;
      const result = spawnSync(process.execPath, ['-e', probe], {
        cwd: dir,
        env,
        encoding: 'utf8',
        windowsHide: true,
      });
      if (result.status !== 0) throw new Error(result.stderr);
      return JSON.parse(result.stdout);
    };
    const guarded = runProbe(true);
    const blocked = fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
    const control = runProbe(false);
    const pass =
      Object.values(guarded).every((v) => v === null) &&
      Object.values(control).every((v) => v === 'leaked') &&
      blocked.length > 0;
    return {
      pass,
      withGuard: guarded,
      withoutGuardControl: control,
      blockedAttempts: blocked.map((b) => `${b.operation} ${b.file}`),
    };
  } finally {
    // Ce processus est lui-même gardé : `rmSync` ne « voit » pas les canaris.
    for (const name of canaries) fs.unlinkSync(path.join(dir, name));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─── Commandes ───────────────────────────────────────────────────────────────

async function main(argv) {
  const [command, ...args] = argv;
  const { flags, rest } = parseFlags(args);
  switch (command) {
    case 'start':
      if (flags['reuse-web-build']) {
        throw new Error(
          '--reuse-web-build est retiré : le build a lieu dans une copie isolée, refaite à chaque démarrage.',
        );
      }
      await require('./launcher').start({
        provider: flags.provider,
        keepLogs: Boolean(flags['keep-logs']),
      });
      return new Promise(() => {}); // premier plan jusqu'à l'arrêt
    case 'stop':
      C.requireRunningState();
      print(await C.control('/stop', {}));
      return 0;
    case 'status': {
      const state = C.readState();
      if (!state || !C.isAlive(state.launcherPid)) {
        print('Aucune recette en cours.');
        return 0;
      }
      const live = await C.control('/state');
      const health = await C.api('GET', '/health').catch(() => ({
        status: 'injoignable',
      }));
      print({ ...live, apiHealth: health.status });
      return 0;
    }
    case 'provider':
      C.requireRunningState();
      print(await C.control('/api/restart', { provider: rest[0] }));
      return 0;
    case 'restart-api':
      C.requireRunningState();
      print(await C.control('/api/restart', {}));
      return 0;
    case 'accounts':
      print({
        password: C.PASSWORD,
        web: `${C.WEB_ORIGIN}/auth/login`,
        accounts: ACCOUNTS.map(({ email, role, use }) => ({
          email,
          role,
          use,
        })),
      });
      return 0;
    case 'owner':
      if (
        typeof flags.label !== 'string' ||
        !/^[a-z0-9-]{1,12}$/.test(flags.label)
      )
        throw new Error('--label=<a-z0-9-, 12 max> requis.');
      print(await createOwner(flags.label, Boolean(flags.expired)));
      return 0;
    case 'expire':
      print(
        await withDb(async (db) => {
          const info = await D.account(db, flags.email);
          const organizationId = ownerOrganization(info);
          return {
            organizationId,
            expiredPeriods: await D.expireOrganization(db, organizationId),
          };
        }),
      );
      return 0;
    case 'org': {
      const status = { suspend: 'suspended', reactivate: 'active' }[rest[0]];
      if (!status) throw new Error('org suspend|reactivate --email=<e>');
      print(
        await withDb(async (db) => {
          const organizationId = ownerOrganization(
            await D.account(db, flags.email),
          );
          await D.setOrganizationStatus(db, organizationId, status);
          return { organizationId, status };
        }),
      );
      return 0;
    }
    case 'payments':
      print(
        await withDb(async (db) => {
          const organizationId = flags.email
            ? ownerOrganization(await D.account(db, flags.email))
            : undefined;
          return {
            counters: await D.counters(db),
            payments: await D.paymentReport(db, organizationId),
          };
        }),
      );
      return 0;
    case 'sim': {
      C.requireRunningState();
      const [action, ...values] = rest;
      if (action === 'stats') print(await C.control('/sim/stats'));
      else if (action === 'transactions')
        print((await C.control('/sim/stats')).transactions);
      else if (action === 'reset') print(await C.control('/sim/reset', {}));
      else if (action === 'settle')
        print(
          await C.control('/sim/settle', {
            reference: flags.reference,
            state: flags.state,
          }),
        );
      else if (action === 'queue-init')
        print(await C.control('/sim/queue-init', { behaviors: values }));
      else if (action === 'queue-status')
        print(
          await C.control('/sim/queue-status', {
            behaviors: values.map(parseStatusBehavior),
          }),
        );
      else
        throw new Error(
          'sim stats|transactions|reset|settle|queue-init|queue-status',
        );
      return 0;
    }
    case 'webhook':
      print(await webhook(flags));
      return 0;
    case 'reconcile-sim': {
      const state = C.requireRunningState();
      return runInherited(
        A.CLI.simulated,
        args,
        C.apiEnv(state.mongodbUri),
        C.WORK_DIR,
      );
    }
    case 'real-cli': {
      const state = C.requireRunningState();
      process.stderr.write(
        '[RECETTE LOCALE] VRAI CLI de production (AppModule sans surcharge : UnavailablePaymentProvider).\n',
      );
      return runInherited(
        A.CLI.real,
        args,
        C.apiEnv(state.mongodbUri),
        C.WORK_DIR,
      );
    }
    case 'scenarios':
    case 'realtime': {
      C.requireRunningState();
      const playwright = flags.playwright;
      if (typeof playwright !== 'string')
        throw new Error(
          '--playwright=<dossier contenant node_modules/playwright> requis.',
        );
      // Résultats hors du répertoire d'état (conservés après le nettoyage).
      const out =
        typeof flags.out === 'string'
          ? path.resolve(flags.out)
          : path.join(os.tmpdir(), `stockmaster-recipe-results-${Date.now()}`);
      process.stdout.write(`Résultats : ${out}
`);
      return runInherited(
        path.join(
          __dirname,
          command === 'realtime' ? 'realtime-scenarios.js' : 'scenarios.js',
        ),
        rest,
        C.baseEnv({
          RECIPE_PLAYWRIGHT_DIR: path.resolve(playwright),
          RECIPE_RESULTS_DIR: out,
          ...(typeof flags.chromium === 'string'
            ? { RECIPE_CHROMIUM: path.resolve(flags.chromium) }
            : {}),
        }),
        C.WORK_DIR,
      );
    }
    case 'isolated':
      return require('./isolated-checks').main(rest[0], rest.slice(1));
    case 'web-canary-check': {
      const result = await require('./web-canary').webCanaryCheck();
      if (typeof flags.out === 'string')
        fs.writeFileSync(
          path.resolve(flags.out),
          JSON.stringify(result, null, 2),
        );
      print(result);
      return result.pass ? 0 : 1;
    }
    case 'env-guard-selftest': {
      const result = envGuardSelftest();
      print(result);
      return result.pass ? 0 : 1;
    }
    case undefined:
    case 'help':
    case '--help':
      print(HELP);
      return 0;
    default:
      print(HELP);
      return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`Erreur : ${error && error.message}\n`);
      process.exit(1);
    },
  );
}
