import 'reflect-metadata';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { Server, Socket, connect, createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { Connection, createConnection, Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { SUBSCRIPTION_PAYMENTS_COLLECTION } from './../src/subscriptions/payments/schemas/subscription-payment.schema';
import { ensureSubscriptionPaymentIndexes } from './../src/subscriptions/payments/subscription-payment-indexes';
import { ensureSubscriptionPeriodIndexes } from './../src/subscriptions/subscription-period-indexes';
import { ensureSaleOperationIndex } from './../src/sales/sale-operation-index';
import { ensureReconciliationIndexes } from './../src/subscriptions/payments/reconciliation/subscription-payment-reconciliation-indexes';
import { SUBSCRIPTION_PAYMENT_RECONCILIATIONS_COLLECTION } from './../src/subscriptions/payments/reconciliation/subscription-payment-reconciliation.schema';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';

/**
 * E2E 1-14D.2G — le VRAI binaire du CLI (`dist/`, construit par
 * `pnpm --filter api build`) en sous-processus, sur le replica set
 * ÉPHÉMÈRE uniquement (jamais `api/.env` ni une autre base).
 *
 * Preuves d'ABSENCE D'ÉCRITURE, y compris de métadonnées :
 * - collections et index de la base comparés avant/après ;
 * - profileur MongoDB (niveau 2) de la base cible : toutes les commandes
 *   du processus (identifié par `appName`) sont relevées et aucune ne doit
 *   écrire (`create`, `createIndexes`, `insert`, `update`, `delete`,
 *   `findAndModify`, `drop*`, `collMod`…) ;
 * - témoin POSITIF : un processus Mongoose aux options PAR DÉFAUT, sur une
 *   base vide, est bien détecté par ce même contrôle.
 * Configurations : `NODE_ENV` absent, `development`, `production`, sur base
 * VIDE (collections et index absents) puis sur base migrée.
 * Régression de l'incident : `.env` factice dans le répertoire courant,
 * `MONGODB_URI` absent de l'environnement → refus AVANT toute connexion
 * (proxy TCP compteur devant la base éphémère).
 */

const API_DIR = join(__dirname, '..');
const CLI = join(
  API_DIR,
  'dist',
  'migrations',
  'reconcile-subscription-payment.js',
);
const APP_NAME = 'reconcile-cli-14d2g-test';
const JWT_SECRET = 'reconciliation-cli-process-14d2g-secret';
const CORS_ORIGIN = 'https://reconciliation-cli.example.com';
const PHONE_MASKED = '+237 6•• ••• •56';

/** Commandes qui modifient données ou métadonnées. */
const WRITE_COMMANDS = [
  'create',
  'createIndexes',
  'insert',
  'update',
  'delete',
  'findAndModify',
  'drop',
  'dropDatabase',
  'dropIndexes',
  'collMod',
  'renameCollection',
  'createSearchIndexes',
];

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runNode(
  args: string[],
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      // Environnement MINIMAL et explicite (jamais les vrais `.env`).
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('CLI de rapprochement — binaire réel, aucune écriture implicite (e2e 1-14D.2G)', () => {
  let replSet: MongoMemoryReplSet;
  /** URI éphémère VALIDÉE par la garde (hôte, port, base e2e). */
  let baseUri: URL;
  let admin: Connection;
  const workdirs: string[] = [];
  const newWorkdir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'reconcile-cli-14d2g-'));
    workdirs.push(dir);
    return dir;
  };

  /**
   * Même hôte éphémère (validé par la garde), base DÉDIÉE au scénario,
   * `appName` du processus pour le profileur.
   */
  const uriFor = (dbName: string) => {
    const url = new URL(baseUri.toString());
    url.pathname = `/${dbName}`;
    url.searchParams.set('appName', APP_NAME);
    return url.toString();
  };
  const db = (dbName: string) => admin.useDb(dbName, { useCache: true });

  const cli = (
    args: string[],
    env: Record<string, string | undefined>,
    cwd = newWorkdir(),
  ) => runNode([CLI, ...args], env, cwd);

  /** Collections (hors profileur) et index, triés : photographie du schéma. */
  async function schemaSnapshot(dbName: string) {
    const database = db(dbName).db!;
    const collections = (await database.listCollections().toArray())
      .map((c) => c.name)
      .filter((name) => name !== 'system.profile')
      .sort();
    const indexes: Record<string, string[]> = {};
    for (const name of collections) {
      indexes[name] = (await database.collection(name).listIndexes().toArray())
        .map((i) => String(i.name))
        .sort();
    }
    return { collections, indexes };
  }

  async function startProfiling(dbName: string) {
    await db(dbName).db!.command({ profile: 2 });
  }

  /** Commandes du processus observées par le profileur (par `appName`). */
  async function processOperations(dbName: string) {
    const entries = await db(dbName)
      .db!.collection('system.profile')
      .find({ appName: APP_NAME })
      .toArray();
    const writes = entries.filter((e) => {
      if (['insert', 'update', 'remove'].includes(String(e.op))) return true;
      const command = (e.command ?? {}) as Record<string, unknown>;
      return WRITE_COMMANDS.some((name) =>
        Object.prototype.hasOwnProperty.call(command, name),
      );
    });
    return { count: entries.length, writes };
  }

  async function migrate(dbName: string) {
    const connection = db(dbName);
    await ensureSaleOperationIndex(connection);
    await ensureSubscriptionPeriodIndexes(connection);
    await ensureSubscriptionPaymentIndexes(connection);
    await ensureReconciliationIndexes(connection);
  }

  async function insertUncertainPayment(dbName: string, provider = 'campay') {
    const _id = new Types.ObjectId();
    await db(dbName)
      .db!.collection(SUBSCRIPTION_PAYMENTS_COLLECTION)
      .insertOne({
        _id,
        organizationId: new Types.ObjectId(),
        requestedBy: new Types.ObjectId(),
        clientOperationId: randomUUID(),
        requestFingerprint: 'f'.repeat(64),
        term: 'monthly',
        amount: 3000,
        currency: 'XAF',
        pricingVersion: 1,
        provider,
        merchantReference: `SM${_id.toHexString().toUpperCase()}`,
        providerReference: null,
        status: 'uncertain',
        open: true,
        payerPhoneMasked: PHONE_MASKED,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    return _id;
  }

  const envFor = (dbName: string, nodeEnv: string | undefined) => ({
    MONGODB_URI: uriFor(dbName),
    JWT_SECRET,
    CORS_ORIGIN,
    ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }),
  });

  const applyArgs = (id: string) => [
    'reconcile',
    `--payment-id=${id}`,
    `--reference=${randomUUID()}`,
    '--apply',
    `--plan=${'a'.repeat(32)}`,
    `--operation-id=${randomUUID()}`,
    '--operator=ops.alice',
    '--reason=uncertain-initiation',
  ];

  const expectNoLeak = (result: CliResult, uri: string) => {
    const text = result.stdout + result.stderr;
    expect(text).not.toContain(uri);
    expect(text).not.toContain('mongodb://');
    expect(text).not.toContain('•');
    expect(text).not.toContain(JWT_SECRET);
  };

  beforeAll(async () => {
    expect(existsSync(CLI)).toBe(true);
    replSet = await startEphemeralMongo();
    try {
      baseUri = new URL(validatedEphemeralUri(replSet));
      admin = await createConnection(baseUri.toString()).asPromise();
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  afterAll(async () => {
    if (admin) await admin.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
    for (const dir of workdirs) rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  // ─── Témoin positif du contrôle ────────────────────────────────────────────

  it('témoin : un processus Mongoose aux options PAR DÉFAUT crée collection et index, et le contrôle le détecte', async () => {
    const dbName = 'cli_14d2g_control';
    await startProfiling(dbName);
    const before = await schemaSnapshot(dbName);
    const script = [
      "const mongoose = require('mongoose');",
      '(async () => {',
      '  const conn = await mongoose.createConnection(process.env.URI).asPromise();',
      '  const schema = new mongoose.Schema({ k: { type: String, index: true } });',
      "  await conn.model('Witness', schema).init();",
      '  await conn.close();',
      '})().catch(() => process.exit(1));',
    ].join('\n');
    const result = await runNode(
      ['-e', script],
      { URI: uriFor(dbName) },
      API_DIR,
    );
    expect(result.code).toBe(0);
    const after = await schemaSnapshot(dbName);
    expect(after.collections).toEqual(
      [...before.collections, 'witnesses'].sort(),
    );
    const { writes } = await processOperations(dbName);
    const names = writes.map(
      (w) => Object.keys((w.command ?? {}) as object)[0],
    );
    expect(names).toEqual(expect.arrayContaining(['create', 'createIndexes']));
  }, 120_000);

  // ─── Base VIDE : aucune collection ni index créés, quel que soit NODE_ENV ──

  it.each([
    // inspect / simulation : paiement introuvable (3) ; --apply : index requis
    // absents → refus AVANT toute action (1).
    ['NODE_ENV absent', undefined, [3, 3, 1]],
    ['development', 'development', [3, 3, 1]],
    // Production : index requis absents → démarrage refusé (1).
    ['production', 'production', [1, 1, 1]],
  ])(
    'base vide, %s : démarrage et commandes sans aucune écriture (collections, index, données)',
    async (_label, nodeEnv, expectedCodes) => {
      const dbName = `cli_14d2g_empty_${nodeEnv ?? 'unset'}`;
      await startProfiling(dbName);
      const before = await schemaSnapshot(dbName);
      expect(before.collections).toEqual([]);
      const env = envFor(dbName, nodeEnv);
      const id = new Types.ObjectId().toHexString();
      const results = [
        await cli(['inspect', `--payment-id=${id}`], env),
        await cli(
          ['reconcile', `--payment-id=${id}`, `--reference=${randomUUID()}`],
          env,
        ),
        await cli(applyArgs(id), env),
      ];
      expect(results.map((r) => r.code)).toEqual(expectedCodes);
      for (const r of results) expectNoLeak(r, env.MONGODB_URI);
      // Refus de l'application faute d'index : erreur nommée, sans détail.
      expect(results[2].stderr).toMatch(/IndexError/);
      expect(await schemaSnapshot(dbName)).toEqual(before);
      const ops = await processOperations(dbName);
      expect(ops.writes).toEqual([]);
      if (nodeEnv !== 'production') {
        // Le processus a bien travaillé sur cette base (lectures observées).
        expect(ops.count).toBeGreaterThan(0);
      }
    },
    240_000,
  );

  // ─── Base migrée : inspection, simulation et application bloquée ───────────

  it.each([
    ['NODE_ENV absent', undefined],
    ['development', 'development'],
    ['production', 'production'],
  ])(
    'base migrée, %s : inspection 0, simulation et application bloquées 4 (fournisseur indisponible), inconnu 3, aucune écriture',
    async (_label, nodeEnv) => {
      const dbName = `cli_14d2g_migrated_${nodeEnv ?? 'unset'}`;
      await migrate(dbName);
      const paymentId = await insertUncertainPayment(dbName);
      await startProfiling(dbName);
      const before = await schemaSnapshot(dbName);
      const payments = db(dbName).db!.collection(
        SUBSCRIPTION_PAYMENTS_COLLECTION,
      );
      const paymentBefore = await payments.findOne({ _id: paymentId });
      const env = envFor(dbName, nodeEnv);
      const id = paymentId.toHexString();

      const inspected = await cli(['inspect', `--payment-id=${id}`], env);
      expect(inspected.code).toBe(0);
      const parsed = JSON.parse(inspected.stdout) as {
        payment: Record<string, unknown>;
      };
      expect(parsed.payment).toMatchObject({
        paymentId: id,
        status: 'uncertain',
        reconcilable: true,
      });
      expect(inspected.stdout).not.toContain('requestFingerprint');

      const sim = await cli(
        ['reconcile', `--payment-id=${id}`, `--reference=${randomUUID()}`],
        env,
      );
      expect(sim.code).toBe(4);
      expect(JSON.parse(sim.stdout)).toMatchObject({
        mode: 'simulation',
        plan: { decision: 'blocked', reason: 'provider-unavailable' },
      });
      const applied = await cli(applyArgs(id), env);
      expect(applied.code).toBe(4);
      expect(JSON.parse(applied.stdout)).toMatchObject({
        result: 'blocked',
        plan: { reason: 'provider-unavailable' },
      });
      const unknown = await cli(
        ['inspect', `--payment-id=${new Types.ObjectId().toHexString()}`],
        env,
      );
      expect(unknown.code).toBe(3);

      for (const r of [inspected, sim, applied, unknown]) {
        expectNoLeak(r, env.MONGODB_URI);
      }
      expect(await schemaSnapshot(dbName)).toEqual(before);
      expect(await payments.findOne({ _id: paymentId })).toEqual(paymentBefore);
      expect(
        await db(dbName)
          .db!.collection(SUBSCRIPTION_PAYMENT_RECONCILIATIONS_COLLECTION)
          .countDocuments(),
      ).toBe(0);
      const ops = await processOperations(dbName);
      expect(ops.writes).toEqual([]);
      expect(ops.count).toBeGreaterThan(0);
    },
    240_000,
  );

  // 1-21B — garde-fou : clé SasPay de BAC À SABLE en production, nouvelles
  // tentatives coupées (`none`) → le CLI refuse de démarrer (configuration
  // invalide), aucune consultation ni écriture, aucun secret affiché. Les
  // chemins HTTP (refresh, webhook) chargent la même configuration.
  it('production + clé SasPay sandbox (none) : rapprochement impossible, code 1, aucune écriture ni fuite', async () => {
    const dbName = 'cli_21b_sandbox_production';
    await migrate(dbName);
    const paymentId = await insertUncertainPayment(dbName, 'saspay');
    await startProfiling(dbName);
    const payments = db(dbName).db!.collection(
      SUBSCRIPTION_PAYMENTS_COLLECTION,
    );
    const paymentBefore = await payments.findOne({ _id: paymentId });
    const sandboxKey = 'sk_test_fake-cli-sandbox-0001';
    const env = {
      ...envFor(dbName, 'production'),
      PAYMENT_PROVIDER_ACTIVE: 'none',
      SASPAY_ENVIRONMENT: 'sandbox',
      SASPAY_SECRET_KEY: sandboxKey,
    };
    const id = paymentId.toHexString();
    const sim = await cli(
      ['reconcile', `--payment-id=${id}`, `--reference=${randomUUID()}`],
      env,
    );
    const applied = await cli(applyArgs(id), env);
    for (const result of [sim, applied]) {
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expectNoLeak(result, env.MONGODB_URI);
      expect(result.stdout + result.stderr).not.toContain(sandboxKey);
    }
    expect(await payments.findOne({ _id: paymentId })).toEqual(paymentBefore);
    expect(
      await db(dbName)
        .db!.collection(SUBSCRIPTION_PAYMENT_RECONCILIATIONS_COLLECTION)
        .countDocuments(),
    ).toBe(0);
    expect((await processOperations(dbName)).writes).toEqual([]);
  }, 240_000);

  // ─── Arguments et régression de l'incident (.env) ──────────────────────────

  it.each([
    [[]],
    [['reconcile', '--payment-id=xyz']],
    [['reconcile', `--payment-id=${'a'.repeat(24)}`, '--provider=campay']],
    [['reconcile', `--payment-id=${'a'.repeat(24)}`, '--provider=simulated']],
    [['reconcile', `--payment-id=${'a'.repeat(24)}`, '--apply']],
  ])(
    'arguments invalides %j → code 2, avant toute connexion',
    async (args) => {
      const result = await cli(args, {});
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Usage');
    },
    60_000,
  );

  describe('régression : `.env` factice dans le répertoire courant', () => {
    let proxy: Server;
    let proxyPort = 0;
    let accepted = 0;
    const sockets: Socket[] = [];

    beforeAll(async () => {
      // Proxy TCP COMPTEUR devant le membre éphémère : toute connexion du
      // processus vers l'URI du `.env` y est comptée.
      const target = baseUri;
      proxy = createServer((client) => {
        accepted += 1;
        const upstream = connect(Number(target.port), target.hostname);
        sockets.push(client, upstream);
        client.pipe(upstream).pipe(client);
        client.on('error', () => upstream.destroy());
        upstream.on('error', () => client.destroy());
      });
      await new Promise<void>((resolve) =>
        proxy.listen(0, '127.0.0.1', resolve),
      );
      proxyPort = (proxy.address() as { port: number }).port;
    });

    afterAll(async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    });

    const proxyUri = (dbName: string) =>
      `mongodb://127.0.0.1:${proxyPort}/${dbName}?directConnection=true&appName=${APP_NAME}`;

    it('`MONGODB_URI` absent de l’environnement, présent dans `.env` → code 1, AUCUNE connexion', async () => {
      const dbName = 'cli_14d2g_dotenv';
      const dir = newWorkdir();
      writeFileSync(
        join(dir, '.env'),
        [
          `MONGODB_URI=${proxyUri(dbName)}`,
          `JWT_SECRET=${JWT_SECRET}`,
          `CORS_ORIGIN=${CORS_ORIGIN}`,
        ].join('\n'),
      );
      accepted = 0;
      for (const args of [
        ['inspect', `--payment-id=${new Types.ObjectId().toHexString()}`],
        [
          'reconcile',
          `--payment-id=${new Types.ObjectId().toHexString()}`,
          `--reference=${randomUUID()}`,
        ],
        applyArgs(new Types.ObjectId().toHexString()),
      ]) {
        const result = await cli(args, {}, dir);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('MONGODB_URI requis');
        expect(result.stdout).toBe('');
      }
      expect(accepted).toBe(0);
      const databases = await admin.db!.admin().listDatabases();
      expect(databases.databases.map((d) => d.name)).not.toContain(dbName);
    }, 120_000);

    it('témoin : la même URI fournie EXPLICITEMENT passe par le proxy (connexions comptées), toujours sans écriture', async () => {
      const dbName = 'cli_14d2g_dotenv_control';
      const dir = newWorkdir();
      writeFileSync(
        join(dir, '.env'),
        `JWT_SECRET=${JWT_SECRET}\nCORS_ORIGIN=${CORS_ORIGIN}\n`,
      );
      await startProfiling(dbName);
      const before = await schemaSnapshot(dbName);
      accepted = 0;
      const result = await cli(
        ['inspect', `--payment-id=${new Types.ObjectId().toHexString()}`],
        { MONGODB_URI: proxyUri(dbName) },
        dir,
      );
      expect(result.code).toBe(3);
      expect(accepted).toBeGreaterThan(0);
      expect(await schemaSnapshot(dbName)).toEqual(before);
      expect((await processOperations(dbName)).writes).toEqual([]);
    }, 120_000);
  });
});
