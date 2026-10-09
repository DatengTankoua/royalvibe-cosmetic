import 'reflect-metadata';
import { Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import sharp from 'sharp';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument } from './../src/users/schemas/user.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { Product } from './../src/products/schemas/product.schema';
import type { ProductDocument } from './../src/products/schemas/product.schema';
import { S3Service, type StoredObjectRef } from './../src/s3/s3.service';
import { StorageQuotaService } from './../src/storage-quota/storage-quota.service';
import {
  StoredObject,
  type StoredObjectDocument,
} from './../src/storage-quota/schemas/stored-object.schema';
import {
  StorageUsage,
  type StorageUsageDocument,
} from './../src/storage-quota/schemas/storage-usage.schema';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import {
  E2E_EMAIL_VERIFIED_AT,
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';
import { OWNER_TERMS } from './e2e/legal-acceptance-fixtures';

const emailSender = createE2eEmailSender();

/**
 * E2E 1-17B — quotas de stockage par organisation.
 *
 * Replica set éphémère (vraies transactions, vrais conflits d'écriture).
 * Stockage SIMULÉ en mémoire par espionnage de `S3Service` (envoi,
 * suppression, `HeadObject`) : aucun réseau ; la comptabilisation, les
 * routes HTTP et MongoDB sont réellement exercées. Quota = 3 photos
 * exactement (taille réelle de la photo de test).
 */

const TEST_JWT_SECRET = 'storage-quota-e2e-only-secret';
const PASSWORD = 'quota-17b-pw-!1x';
const OWNER_A = 'owner-a-17b@stockmaster.test';
const OWNER_B = 'owner-b-17b@stockmaster.test';
const SELLER_A = 'seller-a-17b@stockmaster.test';
const TTL_SECONDS = 900;

describe('E2E 1-17B — quotas de stockage', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let s3: S3Service;
  let quota: StorageQuotaService;
  let productModel: Model<ProductDocument>;
  let organizationModel: Model<OrganizationDocument>;
  let objectModel: Model<StoredObjectDocument>;
  let usageModel: Model<StorageUsageDocument>;

  let png = Buffer.alloc(0);
  let SIZE = 0;
  let orgA = '';
  let ownerA = '';
  let ownerB = '';
  let sellerA = '';
  let sectionA = '';
  let sectionB = '';

  /** Stockage simulé : clé → octets. */
  const bucket = new Map<string, number>();
  const faults = {
    failUpload: false,
    /** L'objet arrive dans le stockage, puis l'envoi échoue (coupure). */
    landThenFailUpload: false,
    failDelete: false,
    unknownHead: new Set<string>(),
  };
  let uploads = 0;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  let productSeq = 0;
  const createProduct = (token: string, section: string, name?: string) =>
    http()
      .post('/products')
      .set(auth(token))
      .field('sectionId', section)
      .field('name', name ?? `Produit ${++productSeq}`)
      .field('purchasePrice', '5')
      .field('salePrice', '10')
      .field('initialQuantity', '3')
      .attach('image', png, { filename: 'p.png', contentType: 'image/png' });
  const replacePhoto = (token: string, id: string) =>
    http()
      .patch(`/products/${id}`)
      .set(auth(token))
      .attach('image', png, { filename: 'p.png', contentType: 'image/png' });
  const usage = async (token: string) =>
    (await http().get('/organizations/current/storage').set(auth(token)))
      .body as Record<string, number | boolean>;
  const later = () =>
    jest
      .spyOn(quota as unknown as { now: () => number }, 'now')
      .mockReturnValue(Date.now() + 2 * TTL_SECONDS * 1000);
  const ledger = (organizationId: string) =>
    objectModel
      .find({ organizationId: new Types.ObjectId(organizationId) })
      .lean()
      .exec();

  async function login(email: string, organizationId?: string) {
    const res = await http()
      .post('/auth/login')
      .send({ email, password: PASSWORD, organizationId });
    expect(res.status).toBe(201);
    return res.body.access_token as string;
  }

  async function register(email: string, organizationName: string) {
    const res = await http()
      .post('/auth/register')
      .send({
        ...OWNER_TERMS,
        name: organizationName,
        email,
        password: PASSWORD,
        organizationName,
      });
    expect(res.status).toBe(201);
    return res.body.organization._id as string;
  }

  beforeAll(async () => {
    png = await sharp({
      create: { width: 24, height: 24, channels: 3, background: '#0a7' },
    })
      .png()
      .toBuffer();
    SIZE = png.length;
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = TEST_JWT_SECRET;
      process.env.S3_ENDPOINT = 'http://127.0.0.1:65535';
      process.env.S3_REGION = 'us-east-1';
      process.env.S3_ACCESS_KEY = 'e2e-local';
      process.env.S3_SECRET_KEY = 'e2e-local';
      process.env.S3_BUCKET = 'e2e-local';
      process.env.S3_FORCE_PATH_STYLE = 'true';
      process.env.CORS_ORIGIN = 'https://quota-e2e.example.com';
      process.env.PUBLIC_APP_URL = 'https://app.quota-e2e.test';
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
      process.env.STORAGE_QUOTA_BYTES = String(3 * SIZE);
      process.env.STORAGE_QUOTA_MODE = 'enforce';
      process.env.STORAGE_RESERVATION_TTL_SECONDS = String(TTL_SECONDS);

      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(emailSender)
        .compile();
      app = moduleFixture.createNestApplication();
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

      s3 = moduleFixture.get(S3Service);
      quota = moduleFixture.get(StorageQuotaService);
      productModel = moduleFixture.get(getModelToken(Product.name));
      organizationModel = moduleFixture.get(getModelToken(Organization.name));
      objectModel = moduleFixture.get(getModelToken(StoredObject.name));
      usageModel = moduleFixture.get(getModelToken(StorageUsage.name));
      const userModel: Model<UserDocument> = moduleFixture.get(
        getModelToken('User'),
      );
      const membershipModel: Model<OrganizationMembershipDocument> =
        moduleFixture.get(getModelToken(OrganizationMembership.name));

      jest
        .spyOn(s3, 'uploadValidatedImage')
        .mockImplementation((body, _prefix, _image, options) => {
          uploads += 1;
          const key = options?.key as string;
          if (faults.failUpload) {
            return Promise.reject(new Error('upload failed'));
          }
          bucket.set(key, body.length);
          if (faults.landThenFailUpload) {
            return Promise.reject(new Error('connexion coupée'));
          }
          return Promise.resolve({ key, storage: s3.storage });
        });
      jest
        .spyOn(s3, 'deleteStoredObject')
        .mockImplementation(
          async (ref: StoredObjectRef | null, prefix: string) => {
            await Promise.resolve(); // réponse asynchrone, comme le stockage
            if (!ref) return 'not_needed';
            if (ref.storage !== s3.storage) return 'retained';
            if (!ref.key.startsWith(`${prefix}/`)) return 'retained';
            if (faults.failDelete) return 'failed';
            bucket.delete(ref.key);
            return 'deleted';
          },
        );
      jest
        .spyOn(s3, 'headStoredObject')
        .mockImplementation(async (ref: StoredObjectRef, prefix: string) => {
          await Promise.resolve();
          if (ref.storage !== s3.storage || !ref.key.startsWith(`${prefix}/`))
            return { state: 'retained' };
          if (faults.unknownHead.has(ref.key)) return { state: 'unknown' };
          const bytes = bucket.get(ref.key);
          return bytes === undefined
            ? { state: 'absent' }
            : { state: 'present', bytes };
        });

      orgA = await register(OWNER_A, 'Quota A');
      await register(OWNER_B, 'Quota B');
      ownerA = await login(OWNER_A);
      ownerB = await login(OWNER_B);
      const seller = await userModel.create({
        emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
        name: 'Seller A',
        email: SELLER_A,
        password: await bcrypt.hash(PASSWORD, 10),
      });
      await membershipModel.create({
        organizationId: new Types.ObjectId(orgA),
        userId: seller._id,
        role: 'seller',
        status: 'active',
      });
      sellerA = await login(SELLER_A, orgA);

      const secA = await http()
        .post('/sections')
        .set(auth(ownerA))
        .send({ name: 'Section A', description: '' });
      expect(secA.status).toBe(201);
      sectionA = secA.body._id as string;
      const secB = await http()
        .post('/sections')
        .set(auth(ownerB))
        .send({ name: 'Section B', description: '' });
      expect(secB.status).toBe(201);
      sectionB = secB.body._id as string;
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
    delete process.env.STORAGE_QUOTA_BYTES;
    delete process.env.STORAGE_QUOTA_MODE;
    delete process.env.STORAGE_RESERVATION_TTL_SECONDS;
  }, 60_000);

  afterEach(() => {
    faults.failUpload = false;
    faults.landThenFailUpload = false;
    faults.failDelete = false;
    faults.unknownHead.clear();
    const now = (quota as unknown as { now: jest.Mock | (() => number) }).now;
    if (jest.isMockFunction(now)) now.mockRestore();
  });

  const productIds: string[] = [];

  it('lecture : occupation de l’organisation courante ; vendeur sans droit de fichier → 403 ; jamais de clé', async () => {
    const a = await http()
      .get('/organizations/current/storage')
      .set(auth(ownerA));
    expect(a.status).toBe(200);
    expect(a.body).toEqual({
      limitBytes: 3 * SIZE,
      usedBytes: 0,
      storedObjects: 0,
      reservedBytes: 0,
      pendingUploads: 0,
      availableBytes: 3 * SIZE,
      enforced: true,
    });
    const s = await http()
      .get('/organizations/current/storage')
      .set(auth(sellerA));
    expect(s.status).toBe(403);
    expect(s.body.code).toBe('PERMISSION_DENIED');
  });

  it('limite EXACTE acceptée (3 photos = quota), la suivante refusée 413 STORAGE_QUOTA_EXCEEDED sans envoi ni produit', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await createProduct(ownerA, sectionA);
      expect(res.status).toBe(201);
      productIds.push(res.body._id as string);
    }
    expect(await usage(ownerA)).toMatchObject({
      usedBytes: 3 * SIZE,
      storedObjects: 3,
      reservedBytes: 0,
      availableBytes: 0,
    });
    const before = uploads;
    const refused = await createProduct(ownerA, sectionA, 'Refusé').set(
      'Accept-Language',
      'en',
    );
    expect(refused.status).toBe(413);
    expect(refused.body).toMatchObject({
      code: 'STORAGE_QUOTA_EXCEEDED',
      limitBytes: 3 * SIZE,
      requestedBytes: SIZE,
    });
    expect(refused.body.message).toMatch(/storage space/i);
    expect(uploads).toBe(before);
    expect(await productModel.countDocuments({ name: 'Refusé' })).toBe(0);
    const entries = await ledger(orgA);
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.state === 'attached')).toBe(true);
    expect(entries.every((e) => e.bytes === SIZE)).toBe(true);
  });

  it('isolation : l’organisation B n’est pas affectée par le quota de A', async () => {
    const res = await createProduct(ownerB, sectionB);
    expect(res.status).toBe(201);
    expect(await usage(ownerB)).toMatchObject({ usedBytes: SIZE });
    expect(await usage(ownerA)).toMatchObject({ usedBytes: 3 * SIZE });
  });

  it('remplacement au quota plein : coexistence comptée → 413, ANCIENNE photo conservée (base et stockage)', async () => {
    const before = await productModel.findById(productIds[0]).lean().exec();
    const res = await replacePhoto(ownerA, productIds[0]);
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('STORAGE_QUOTA_EXCEEDED');
    const after = await productModel.findById(productIds[0]).lean().exec();
    expect(after!.imageKey).toBe(before!.imageKey);
    expect(bucket.has(before!.imageKey!)).toBe(true);
  });

  it('corbeille : ne libère rien ; purge : libère après suppression confirmée', async () => {
    const trashed = await http()
      .delete(`/products/${productIds[2]}`)
      .set(auth(ownerA));
    expect(trashed.status).toBe(200);
    expect(await usage(ownerA)).toMatchObject({ usedBytes: 3 * SIZE });
    const key = (await productModel.findById(productIds[2]).lean().exec())!
      .imageKey!;
    const purged = await http()
      .delete(`/products/${productIds[2]}/permanent`)
      .set(auth(ownerA));
    expect(purged.status).toBe(200);
    expect(purged.body.storageCleanup).toBe('deleted');
    expect(bucket.has(key)).toBe(false);
    expect(await usage(ownerA)).toMatchObject({
      usedBytes: 2 * SIZE,
      storedObjects: 2,
    });
  });

  it('remplacement avec de la place : nouvelle photo enregistrée, ancienne supprimée APRÈS, occupation inchangée', async () => {
    const before = await productModel.findById(productIds[0]).lean().exec();
    const res = await replacePhoto(ownerA, productIds[0]);
    expect(res.status).toBe(200);
    expect(res.body.storageCleanup).toBe('deleted');
    const after = await productModel.findById(productIds[0]).lean().exec();
    expect(after!.imageKey).not.toBe(before!.imageKey);
    expect(bucket.has(before!.imageKey!)).toBe(false);
    expect(bucket.has(after!.imageKey!)).toBe(true);
    expect(await usage(ownerA)).toMatchObject({
      usedBytes: 2 * SIZE,
      reservedBytes: 0,
    });
  });

  it('échec d’envoi : l’erreur ne prouve pas l’absence — réservation comptée jusqu’à l’échéance, puis libérée par la reprise ; aucun produit', async () => {
    faults.failUpload = true;
    const res = await createProduct(ownerA, sectionA, 'Envoi raté');
    expect(res.status).toBe(500);
    expect(await usage(ownerA)).toMatchObject({
      usedBytes: 2 * SIZE,
      reservedBytes: SIZE,
      pendingUploads: 1,
    });
    expect(await productModel.countDocuments({ name: 'Envoi raté' })).toBe(0);
    faults.failUpload = false;
    expect((await quota.recover()).examined).toBe(0);
    later();
    expect((await quota.recover()).released).toBe(1);
    expect(await usage(ownerA)).toMatchObject({
      usedBytes: 2 * SIZE,
      reservedBytes: 0,
      pendingUploads: 0,
    });
  });

  it('échec MongoDB après envoi (nom en double) : nouveau fichier supprimé et libéré, aucun double comptage', async () => {
    const existing = await productModel.findById(productIds[1]).lean().exec();
    const res = await createProduct(ownerA, sectionA, existing!.name);
    expect(res.status).toBe(409);
    expect(await usage(ownerA)).toMatchObject({
      usedBytes: 2 * SIZE,
      storedObjects: 2,
      reservedBytes: 0,
    });
    expect((await ledger(orgA)).length).toBe(2);
  });

  it('deux envois concurrents pour la DERNIÈRE place : un seul accepté', async () => {
    const [r1, r2] = await Promise.all([
      createProduct(ownerA, sectionA, 'Course 1'),
      createProduct(ownerA, sectionA, 'Course 2'),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 413]);
    expect(await usage(ownerA)).toMatchObject({
      usedBytes: 3 * SIZE,
      reservedBytes: 0,
    });
    const created = r1.status === 201 ? r1 : r2;
    productIds.push(created.body._id as string);
  });

  it('suppression en échec : comptée tant qu’elle n’est pas confirmée, puis reprise sans double libération', async () => {
    const id = productIds[productIds.length - 1];
    faults.failDelete = true;
    const purged = await http()
      .delete(`/products/${id}/permanent`)
      .set(auth(ownerA));
    expect(purged.status).toBe(200);
    expect(purged.body.storageCleanup).toBe('failed');
    expect(await usage(ownerA)).toMatchObject({ usedBytes: 3 * SIZE });
    expect(
      (await ledger(orgA)).filter((e) => e.state === 'deleting'),
    ).toHaveLength(1);

    // Reprise avant l'échéance : rien n'est fait.
    faults.failDelete = false;
    expect((await quota.recover()).examined).toBe(0);

    later();
    const report = await quota.recover();
    expect(report).toMatchObject({ released: 1 });
    expect(await usage(ownerA)).toMatchObject({ usedBytes: 2 * SIZE });
    // Rejouée : aucune nouvelle libération.
    expect((await quota.recover()).released).toBe(0);
    expect(await usage(ownerA)).toMatchObject({ usedBytes: 2 * SIZE });
  });

  it('interruption pendant l’envoi : réservation conservée, puis reprise après échéance (fichier supprimé, aucun double comptage)', async () => {
    faults.landThenFailUpload = true;
    faults.failDelete = true;
    const res = await createProduct(ownerA, sectionA, 'Coupure');
    expect(res.status).toBe(500);
    // Fichier peut-être envoyé : réservation conservée, jamais libérée sur
    // la seule foi de l'erreur.
    expect(await usage(ownerA)).toMatchObject({
      usedBytes: 2 * SIZE,
      reservedBytes: SIZE,
      pendingUploads: 1,
      availableBytes: 0,
    });
    faults.landThenFailUpload = false;
    faults.failDelete = false;
    const landed = (await ledger(orgA)).find((e) => e.state === 'reserved')!;
    expect(bucket.has(landed.key)).toBe(true);

    later();
    expect((await quota.recover()).released).toBe(1);
    expect(bucket.has(landed.key)).toBe(false);
    expect(await usage(ownerA)).toMatchObject({
      usedBytes: 2 * SIZE,
      reservedBytes: 0,
      pendingUploads: 0,
    });
    expect((await quota.recover()).examined).toBe(0);
  });

  it('interruption après envoi (avant écriture) : reprise rattache un fichier référencé, supprime un fichier orphelin', async () => {
    // Deux envois « interrompus » simulés au-delà du quota (mode `track`).
    const config = quota.config as { mode: 'enforce' | 'track' };
    config.mode = 'track';
    const stage = () =>
      quota.store({
        organizationId: orgA,
        kind: 'product_image',
        body: png,
        image: { extension: 'png', contentType: 'image/png' },
      });
    const orphan = await stage().finally(() => undefined);
    const kept = await stage().finally(() => {
      config.mode = 'enforce';
    });
    // Le second fichier a été référencé (écriture validée, rattachement
    // perdu) ; le premier ne l'a jamais été.
    await productModel.updateOne(
      { _id: productIds[1] },
      { $set: { imageKey: kept.key, imageStorage: kept.storage } },
    );
    expect(await usage(ownerA)).toMatchObject({ usedBytes: 4 * SIZE });
    later();
    const report = await quota.recover();
    expect(report).toMatchObject({ released: 1, attached: 1 });
    expect(bucket.has(orphan.key)).toBe(false);
    expect(bucket.has(kept.key)).toBe(true);
    // L'ancienne photo du produit 1 n'est plus référencée mais reste comptée
    // (attachée) : `recompute` confirme la cohérence compteur/registre.
    const check = await quota.recompute(orgA, false);
    expect(check.consistent).toBe(true);
    expect(check.current.storedBytes).toBe(3 * SIZE);
  });

  it('logos : comptés dans le même quota, remplacement et suppression libèrent l’ancien', async () => {
    // Remise à un état connu : 2 photos stockées (+ ancienne photo du
    // produit 1, toujours comptée) → purge du produit 1 pour libérer.
    const res1 = await http()
      .delete(`/products/${productIds[1]}/permanent`)
      .set(auth(ownerA));
    expect(res1.status).toBe(200);
    const used = (await usage(ownerA)).usedBytes as number;
    const logo = await http()
      .patch('/organizations/current/branding')
      .set(auth(ownerA))
      .attach('logo', png, { filename: 'l.png', contentType: 'image/png' });
    expect(logo.status).toBe(200);
    expect(await usage(ownerA)).toMatchObject({ usedBytes: used + SIZE });
    const removed = await http()
      .delete('/organizations/current/logo')
      .set(auth(ownerA));
    expect(removed.status).toBe(200);
    expect(removed.body.storageCleanup).toBe('deleted');
    expect(await usage(ownerA)).toMatchObject({ usedBytes: used });
  });

  it('mode `track` : comptabilise sans bloquer', async () => {
    const config = quota.config as { mode: 'enforce' | 'track' };
    config.mode = 'track';
    try {
      // Remplir au-delà du quota.
      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        statuses.push((await createProduct(ownerB, sectionB)).status);
      }
      expect(statuses).toEqual([201, 201, 201]);
      const u = await usage(ownerB);
      expect(u).toMatchObject({ usedBytes: 4 * SIZE, enforced: false });
      expect(u.availableBytes).toBe(0);
    } finally {
      config.mode = 'enforce';
    }
    expect((await createProduct(ownerB, sectionB)).status).toBe(413);
  });

  it('initialisation des fichiers existants : diagnostic sans écriture, application relançable, tailles vérifiées, préfixe et stockage exacts', async () => {
    const orgC = new Types.ObjectId();
    await organizationModel.collection.insertOne({
      _id: orgC,
      name: 'Org C',
      slug: `org-c-${orgC.toString()}`,
      logoKey: `organizations/${orgC.toString()}/branding/logo.png`,
      logoStorage: s3.storage,
      brandColor: '#FF6A00',
      currency: 'XAF',
      status: 'active',
    });
    const prefix = `organizations/${orgC.toString()}/products`;
    const base = {
      organizationId: orgC,
      sectionId: new Types.ObjectId(),
      purchasePrice: 1,
      salePrice: 2,
      initialQuantity: 1,
      remainingQuantity: 1,
    };
    bucket.set(`organizations/${orgC.toString()}/branding/logo.png`, 1000);
    bucket.set(`${prefix}/a.png`, 2000);
    bucket.set(`${prefix}/trash.png`, 3000);
    bucket.set(`${prefix}/unknown.png`, 4000);
    faults.unknownHead.add(`${prefix}/unknown.png`);
    await productModel.collection.insertMany([
      {
        ...base,
        name: 'a',
        imageKey: `${prefix}/a.png`,
        imageStorage: s3.storage,
        deletedAt: null,
      },
      {
        ...base,
        name: 't',
        imageKey: `${prefix}/trash.png`,
        imageStorage: s3.storage,
        deletedAt: new Date(),
      },
      {
        ...base,
        name: 'm',
        imageKey: `${prefix}/missing.png`,
        imageStorage: s3.storage,
        deletedAt: null,
      },
      {
        ...base,
        name: 'u',
        imageKey: `${prefix}/unknown.png`,
        imageStorage: s3.storage,
        deletedAt: null,
      },
      {
        ...base,
        name: 'o',
        imageKey: `${prefix}/other.png`,
        imageStorage: 'autre/stockage',
        deletedAt: null,
      },
      {
        ...base,
        name: 'x',
        imageKey: `organizations/${orgA}/products/x.png`,
        imageStorage: s3.storage,
        deletedAt: null,
      },
    ]);
    const ledgerBefore = await objectModel.countDocuments();

    const diag = await quota.initializeExisting({
      apply: false,
      organizationId: orgC.toString(),
    });
    expect(await objectModel.countDocuments()).toBe(ledgerBefore);
    expect(await usageModel.exists({ _id: orgC })).toBeNull();
    expect(diag.complete).toBe(false);
    const c = diag.organizations.find(
      (o) => o.organizationId === orgC.toString(),
    )!;
    expect(c.counts).toEqual({
      to_count: 3,
      missing: 1,
      unknown_size: 1,
      other_storage: 1,
      bad_prefix: 1,
    });
    expect(c.bytes.to_count).toBe(6000);
    expect(c.projectedUsedBytes).toBe(6000);
    expect(JSON.stringify(diag)).not.toContain('.png');

    const applied = await quota.initializeExisting({
      apply: true,
      organizationId: orgC.toString(),
    });
    expect(
      applied.organizations.find((o) => o.organizationId === orgC.toString())!
        .counts.counted,
    ).toBe(3);
    const view = await quota.usage(orgC.toString());
    expect(view).toMatchObject({ usedBytes: 6000, storedObjects: 3 });

    // Relance : rien n'est recompté.
    const again = await quota.initializeExisting({
      apply: true,
      organizationId: orgC.toString(),
    });
    expect(
      again.organizations.find((o) => o.organizationId === orgC.toString())!
        .counts.already_tracked,
    ).toBe(3);
    expect(await quota.usage(orgC.toString())).toMatchObject({
      usedBytes: 6000,
    });
    // Taille devenue connue : comptée à la relance suivante seulement.
    faults.unknownHead.clear();
    await quota.initializeExisting({
      apply: true,
      organizationId: orgC.toString(),
    });
    expect(await quota.usage(orgC.toString())).toMatchObject({
      usedBytes: 10000,
      storedObjects: 4,
    });
    expect((await quota.recompute(orgC.toString(), false)).consistent).toBe(
      true,
    );
  });
});
