import 'reflect-metadata';
import { Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import request from 'supertest';
import sharp from 'sharp';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { Product } from './../src/products/schemas/product.schema';
import type { ProductDocument } from './../src/products/schemas/product.schema';
import { S3Service, type StoredObjectRef } from './../src/s3/s3.service';
import {
  StorageQuotaService,
  type StagedObject,
} from './../src/storage-quota/storage-quota.service';
import {
  StoredObject,
  type StoredObjectDocument,
} from './../src/storage-quota/schemas/stored-object.schema';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import {
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';
import { OWNER_TERMS } from './e2e/legal-acceptance-fixtures';

const emailSender = createE2eEmailSender();

/**
 * E2E 1-17B (complément) — fichiers non suivis et réconciliation.
 *
 * Replica set éphémère (vraies transactions). Stockage SIMULÉ en mémoire,
 * PARTAGÉ entre deux instances successives de l'application : la seconde
 * instance simule un REDÉMARRAGE (aucun état en mémoire conservé, seuls
 * MongoDB et le stockage subsistent). Ordre des événements imposé par des
 * barrières explicites, sans attente à durée fixe pour le scénario de
 * l'envoi tardif.
 */

const TEST_JWT_SECRET = 'storage-reconciliation-e2e-secret';
const PASSWORD = 'reco-17b-pw-!1x';
const TTL_SECONDS = 900;

interface FakeObject {
  bytes: number;
  lastModified: Date;
}

/** Stockage simulé partagé (survit au « redémarrage »). */
const bucket = new Map<string, FakeObject>();

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Instance {
  app: INestApplication<App>;
  s3: S3Service;
  quota: StorageQuotaService;
  products: Model<ProductDocument>;
  objects: Model<StoredObjectDocument>;
  /** Prochains envois : comportement imposé (sinon envoi immédiat). */
  uploadHooks: ((key: string, body: Buffer) => Promise<void>)[];
}

async function boot(): Promise<Instance> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(EMAIL_SENDER)
    .useValue(emailSender)
    .compile();
  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  autoConfirmVerificationEmails(app, emailSender);
  const s3 = moduleFixture.get(S3Service);
  const instance: Instance = {
    app,
    s3,
    quota: moduleFixture.get(StorageQuotaService),
    products: moduleFixture.get(getModelToken(Product.name)),
    objects: moduleFixture.get(getModelToken(StoredObject.name)),
    uploadHooks: [],
  };
  jest
    .spyOn(s3, 'uploadValidatedImage')
    .mockImplementation(async (body, _prefix, _image, options) => {
      const key = options?.key as string;
      const hook = instance.uploadHooks.shift();
      if (hook) await hook(key, body);
      else bucket.set(key, { bytes: body.length, lastModified: new Date() });
      return { key, storage: s3.storage };
    });
  jest
    .spyOn(s3, 'deleteStoredObject')
    .mockImplementation(async (ref: StoredObjectRef | null, prefix: string) => {
      await Promise.resolve();
      if (!ref) return 'not_needed';
      if (ref.storage !== s3.storage || !ref.key.startsWith(`${prefix}/`)) {
        return 'retained';
      }
      // Suppression idempotente (comme S3/R2) : absent → confirmé.
      bucket.delete(ref.key);
      return 'deleted';
    });
  jest
    .spyOn(s3, 'headStoredObject')
    .mockImplementation(async (ref: StoredObjectRef, prefix: string) => {
      await Promise.resolve();
      if (ref.storage !== s3.storage || !ref.key.startsWith(`${prefix}/`)) {
        return { state: 'retained' };
      }
      const object = bucket.get(ref.key);
      return object
        ? { state: 'present', bytes: object.bytes }
        : { state: 'absent' };
    });
  // Pages de 2 objets : la pagination de l'inventaire est exercée.
  jest
    .spyOn(s3, 'listStoredObjects')
    .mockImplementation(async (prefix: string, token?: string) => {
      await Promise.resolve();
      const keys = [...bucket.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort();
      const start = token ? Number(token) : 0;
      const slice = keys.slice(start, start + 2);
      return {
        objects: slice.map((key) => ({
          key,
          bytes: bucket.get(key)!.bytes,
          lastModified: bucket.get(key)!.lastModified,
        })),
        next: start + 2 < keys.length ? String(start + 2) : undefined,
      };
    });
  return instance;
}

describe('E2E 1-17B — réconciliation du stockage', () => {
  let current: Instance;
  let png = Buffer.alloc(0);
  let SIZE = 0;
  let orgA = '';
  let ownerA = '';
  let sectionA = '';
  let seq = 0;

  const http = () => request(current.app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${ownerA}` });
  const createProduct = (name = `Produit ${++seq}`) =>
    http()
      .post('/products')
      .set(auth())
      .field('sectionId', sectionA)
      .field('name', name)
      .field('purchasePrice', '5')
      .field('salePrice', '10')
      .field('initialQuantity', '3')
      .attach('image', png, { filename: 'p.png', contentType: 'image/png' });
  const later = (instance: Instance, seconds = 2 * TTL_SECONDS) =>
    jest
      .spyOn(instance.quota as unknown as { now: () => number }, 'now')
      .mockReturnValue(Date.now() + seconds * 1000);
  const usage = () => current.quota.usage(orgA);
  const keyOf = async (productId: string) =>
    (await current.products.findById(productId).lean().exec())!.imageKey!;
  const productPrefix = () => `organizations/${orgA}/products`;

  beforeAll(async () => {
    png = await sharp({
      create: { width: 20, height: 20, channels: 3, background: '#a50' },
    })
      .png()
      .toBuffer();
    SIZE = png.length;
    const replSet = await startEphemeralMongo();
    process.env.MONGODB_URI = validatedEphemeralUri(replSet);
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    process.env.S3_ENDPOINT = 'http://127.0.0.1:65535';
    process.env.S3_REGION = 'us-east-1';
    process.env.S3_ACCESS_KEY = 'e2e-local';
    process.env.S3_SECRET_KEY = 'e2e-local';
    process.env.S3_BUCKET = 'e2e-local';
    process.env.S3_FORCE_PATH_STYLE = 'true';
    process.env.CORS_ORIGIN = 'https://reco-e2e.example.com';
    process.env.PUBLIC_APP_URL = 'https://app.reco-e2e.test';
    process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
    process.env.STORAGE_QUOTA_BYTES = String(100 * SIZE);
    process.env.STORAGE_QUOTA_MODE = 'enforce';
    process.env.STORAGE_RESERVATION_TTL_SECONDS = String(TTL_SECONDS);
    current = await boot();
    const reg = await http()
      .post('/auth/register')
      .send({
        ...OWNER_TERMS,
        name: 'Owner Reco',
        email: 'owner-reco-17b@stockmaster.test',
        password: PASSWORD,
        organizationName: 'Reco A',
      });
    expect(reg.status).toBe(201);
    orgA = reg.body.organization._id as string;
    const login = await http()
      .post('/auth/login')
      .send({ email: 'owner-reco-17b@stockmaster.test', password: PASSWORD });
    ownerA = login.body.access_token as string;
    const sec = await http()
      .post('/sections')
      .set(auth())
      .send({ name: 'Section', description: '' });
    sectionA = sec.body._id as string;
  }, 180_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    if (current) await current.app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
    delete process.env.STORAGE_QUOTA_BYTES;
    delete process.env.STORAGE_QUOTA_MODE;
    delete process.env.STORAGE_RESERVATION_TTL_SECONDS;
  }, 60_000);

  it('envoi annulé/échoué : jamais libéré sur la seule erreur — réservation comptée jusqu’à l’échéance, puis libérée après suppression', async () => {
    const before = await usage();
    current.uploadHooks.push(async (key, body) => {
      await Promise.resolve();
      // Le corps arrive, puis la connexion est coupée (annulation SDK).
      bucket.set(key, { bytes: body.length, lastModified: new Date() });
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const res = await createProduct('Annulé');
    expect(res.status).toBe(500);
    expect(await usage()).toMatchObject({
      usedBytes: before.usedBytes,
      reservedBytes: before.reservedBytes + SIZE,
      pendingUploads: 1,
    });
    // Reprise AVANT l'échéance : rien.
    expect((await current.quota.recover()).examined).toBe(0);
    expect(
      await current.quota.inspectRecovery({ organizationId: orgA }),
    ).toMatchObject({
      due: { count: 0 },
      notYetDue: { count: 1, bytes: SIZE },
    });
    const clock = later(current);
    // État des lieux (CLI `recover` sans --apply) : échue, AUCUNE écriture.
    const ledgerBefore = await current.objects.find().lean();
    const inspection = await current.quota.inspectRecovery({
      organizationId: orgA,
    });
    expect(inspection.due).toMatchObject({
      count: 1,
      bytes: SIZE,
      byState: { reserved: { count: 1, bytes: SIZE } },
    });
    expect(await current.objects.find().lean()).toEqual(ledgerBefore);
    expect((await usage()).reservedBytes).toBe(before.reservedBytes + SIZE);
    expect((await current.quota.recover()).released).toBe(1);
    clock.mockRestore();
    expect(await usage()).toMatchObject({
      usedBytes: before.usedBytes,
      reservedBytes: before.reservedBytes,
    });
  });

  it('envoi retardé → reprise → arrivée TARDIVE → redémarrage : fichier retrouvé, compté puis supprimé ; aucun fichier référencé supprimé', async () => {
    const kept = await createProduct('Référencé');
    expect(kept.status).toBe(201);
    const keptKey = await keyOf(kept.body._id as string);
    const base = await usage();

    // 1. Envoi retardé : la requête reste en vol (barrière jamais levée).
    const started = deferred<string>();
    const neverSettles = new Promise<void>(() => undefined);
    current.uploadHooks.push(async (key) => {
      started.resolve(key);
      await neverSettles;
    });
    const inFlight: Promise<StagedObject> = current.quota.store({
      organizationId: orgA,
      kind: 'product_image',
      body: png,
      image: { extension: 'png', contentType: 'image/png' },
    });
    inFlight.catch(() => undefined);
    const lateKey = await started.promise;
    expect(lateKey.startsWith(`${productPrefix()}/`)).toBe(true);
    expect((await usage()).reservedBytes).toBe(base.reservedBytes + SIZE);

    // 2. Reprise après échéance : objet absent À CET INSTANT → libéré.
    const clock = later(current);
    expect((await current.quota.recover()).released).toBe(1);
    clock.mockRestore();
    expect(await current.objects.exists({ key: lateKey })).toBeNull();
    expect(await usage()).toMatchObject({
      usedBytes: base.usedBytes,
      reservedBytes: base.reservedBytes,
    });

    // 3. Arrivée tardive du fichier, puis arrêt du processus (la requête ne
    //    se termine jamais) : fichier présent, aucune entrée au registre.
    bucket.set(lateKey, { bytes: SIZE, lastModified: new Date() });
    await current.app.close();

    // 4. Redémarrage : nouvelle instance, aucun état en mémoire.
    current = await boot();
    const diag = await current.quota.reconcileInventory({
      apply: false,
      organizationId: orgA,
    });
    expect(diag.totals.untracked_unreferenced).toBe(1);
    expect(await current.objects.exists({ key: lateKey })).toBeNull();
    expect(JSON.stringify(diag)).not.toContain('.png');

    // 5. Inventaire appliqué : fichier COMPTÉ immédiatement, suppression
    //    différée (délai de grâce depuis son arrivée).
    const applied = await current.quota.reconcileInventory({
      apply: true,
      organizationId: orgA,
    });
    expect(applied).toMatchObject({ deleted: 0, pendingDeletion: 1 });
    expect((await usage()).usedBytes).toBe(base.usedBytes + SIZE);
    expect(bucket.has(lateKey)).toBe(true);

    // 6. Après le délai : reprise → suppression confirmée → libération.
    const clock2 = later(current);
    expect((await current.quota.recover()).released).toBe(1);
    clock2.mockRestore();
    expect(bucket.has(lateKey)).toBe(false);
    expect(await usage()).toMatchObject({
      usedBytes: base.usedBytes,
      reservedBytes: base.reservedBytes,
    });
    // Fichier référencé jamais supprimé ; relance sans double comptage.
    expect(bucket.has(keptKey)).toBe(true);
    const again = await current.quota.reconcileInventory({
      apply: true,
      organizationId: orgA,
    });
    expect(again.totals.untracked_unreferenced ?? 0).toBe(0);
    expect((await usage()).usedBytes).toBe(base.usedBytes);
    expect((await current.quota.recompute(orgA, false)).consistent).toBe(true);
  });

  it('inventaire : fichier non suivi RÉFÉRENCÉ → compté et rattaché, jamais supprimé ; clé hors schéma ignorée', async () => {
    const base = await usage();
    const legacyKey = `${productPrefix()}/legacy-sans-registre.png`;
    bucket.set(legacyKey, { bytes: 1234, lastModified: new Date(0) });
    const foreignKey = `organizations/${orgA}/autre/x.png`;
    bucket.set(foreignKey, { bytes: 99, lastModified: new Date(0) });
    await current.products.collection.insertOne({
      organizationId: new Types.ObjectId(orgA),
      sectionId: new Types.ObjectId(sectionA),
      name: 'Écrit par l’ancien code',
      imageKey: legacyKey,
      imageStorage: current.s3.storage,
      purchasePrice: 1,
      salePrice: 2,
      initialQuantity: 1,
      remainingQuantity: 1,
      deletedAt: null,
    });
    const report = await current.quota.reconcileInventory({
      apply: true,
      organizationId: orgA,
    });
    expect(report.totals).toMatchObject({
      untracked_referenced: 1,
      foreign_key: 1,
    });
    const entry = await current.objects.findOne({ key: legacyKey }).lean();
    expect(entry).toMatchObject({
      state: 'attached',
      bytes: 1234,
      source: 'reconciliation',
    });
    const clock = later(current);
    await current.quota.recover();
    clock.mockRestore();
    expect(bucket.has(legacyKey)).toBe(true);
    expect(bucket.has(foreignKey)).toBe(true);
    expect((await usage()).usedBytes).toBe(base.usedBytes + 1234);
    bucket.delete(foreignKey);
  });

  it('initialisation : détachement CONCURRENT (purge) sérialisé par le verrou de référence — aucune entrée orpheline, octets libérés une fois', async () => {
    const key = `${productPrefix()}/init-race.png`;
    bucket.set(key, { bytes: 777, lastModified: new Date(0) });
    const inserted = await current.products.collection.insertOne({
      organizationId: new Types.ObjectId(orgA),
      sectionId: new Types.ObjectId(sectionA),
      name: 'Course initialisation',
      imageKey: key,
      imageStorage: current.s3.storage,
      purchasePrice: 1,
      salePrice: 2,
      initialQuantity: 1,
      remainingQuantity: 1,
      deletedAt: null,
    });
    const productId = String(inserted.insertedId);
    const base = await usage();

    // Barrière DANS la transaction d'initialisation, juste après le
    // verrouillage de la référence.
    const locked = deferred();
    const resume = deferred();
    const service = current.quota as unknown as {
      lockReference: (...args: unknown[]) => Promise<boolean>;
    };
    const original = service.lockReference.bind(current.quota);
    let paused = false;
    const lockSpy = jest
      .spyOn(service, 'lockReference')
      .mockImplementation(async (...args: unknown[]) => {
        const result = await original(...args);
        if (!paused && (args[0] as { key: string }).key === key) {
          paused = true;
          locked.resolve();
          await resume.promise;
        }
        return result;
      });
    const deleteSpy = jest.spyOn(current.products, 'findOneAndDelete');

    const init = current.quota.initializeExisting({
      apply: true,
      organizationId: orgA,
    });
    await locked.promise;
    // Purge concurrente, lancée pendant que l'initialisation tient le verrou.
    const purge = http()
      .delete(`/products/${productId}/permanent`)
      .set(auth())
      .then((r) => r);
    await new Promise<void>((resolve) => {
      const poll = () =>
        deleteSpy.mock.calls.length > 0 ? resolve() : setTimeout(poll, 20);
      poll();
    });
    resume.resolve();
    const [initReport, purged] = await Promise.all([init, purge]);
    lockSpy.mockRestore();
    deleteSpy.mockRestore();

    expect(purged.status).toBe(200);
    expect(
      initReport.organizations.find((o) => o.organizationId === orgA)!.counts
        .counted,
    ).toBe(1);
    // Purge sérialisée APRÈS le comptage : elle a détaché puis libéré.
    expect(bucket.has(key)).toBe(false);
    expect(await current.objects.exists({ key })).toBeNull();
    expect((await usage()).usedBytes).toBe(base.usedBytes);
    const orphans = await current.quota.reconcileOrphans({
      apply: false,
      organizationId: orgA,
    });
    expect(orphans.orphaned).toBe(0);
    expect((await current.quota.recompute(orgA, false)).consistent).toBe(true);
  });

  it('entrées attached sans référence : détectées, puis libérées seulement après suppression confirmée ; relançable ; référence revenue → conservée', async () => {
    // Ancien code : photo remplacée sans passer par le registre.
    const created = await createProduct('Remplacé par l’ancien code');
    const productId = created.body._id as string;
    const oldKey = await keyOf(productId);
    const newKey = `${productPrefix()}/ancien-code-nouvelle.png`;
    bucket.set(newKey, { bytes: 555, lastModified: new Date(0) });
    await current.products.updateOne(
      { _id: productId },
      { $set: { imageKey: newKey } },
    );
    bucket.delete(oldKey); // l'ancien code a supprimé l'ancien fichier
    const base = await usage();

    const diag = await current.quota.reconcileOrphans({
      apply: false,
      organizationId: orgA,
    });
    expect(diag).toMatchObject({ orphaned: 1, orphanedBytes: SIZE });
    expect((await usage()).usedBytes).toBe(base.usedBytes); // aucune écriture

    // Référence revenue entre la détection et l'écriture : conservée.
    const service = current.quota as unknown as {
      isReferenced: (...args: unknown[]) => Promise<boolean>;
    };
    const original = service.isReferenced.bind(current.quota);
    let first = true;
    const spy = jest
      .spyOn(service, 'isReferenced')
      .mockImplementation(async (...args: unknown[]) => {
        await Promise.resolve();
        if (first && (args[0] as { key: string }).key === oldKey) {
          first = false;
          return false; // détection
        }
        return (args[0] as { key: string }).key === oldKey
          ? true // relecture en transaction : de nouveau référencé
          : original(...args);
      });
    const raced = await current.quota.reconcileOrphans({
      apply: true,
      organizationId: orgA,
    });
    spy.mockRestore();
    expect(raced).toMatchObject({ released: 0, reattached: 1 });
    expect((await usage()).usedBytes).toBe(base.usedBytes);

    // Application réelle : absence confirmée (suppression idempotente).
    const applied = await current.quota.reconcileOrphans({
      apply: true,
      organizationId: orgA,
    });
    expect(applied).toMatchObject({ orphaned: 1, released: 1, retry: 0 });
    expect((await usage()).usedBytes).toBe(base.usedBytes - SIZE);
    const rerun = await current.quota.reconcileOrphans({
      apply: true,
      organizationId: orgA,
    });
    expect(rerun.orphaned).toBe(0);
    expect((await usage()).usedBytes).toBe(base.usedBytes - SIZE);

    // Le nouveau fichier de l'ancien code est retrouvé par l'inventaire.
    const inv = await current.quota.reconcileInventory({
      apply: true,
      organizationId: orgA,
    });
    expect(inv.totals.untracked_referenced).toBe(1);
    expect((await usage()).usedBytes).toBe(base.usedBytes - SIZE + 555);
    expect(bucket.has(newKey)).toBe(true);
    expect((await current.quota.recompute(orgA, false)).consistent).toBe(true);
  });
});
