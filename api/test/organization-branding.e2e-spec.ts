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
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import { S3Service } from './../src/s3/s3.service';
import { OrganizationsService } from './../src/organizations/organizations.service';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import {
  buildOriginAllowlist,
  parseCORSOrigin,
  buildHttpCorsOptions,
} from './../src/events/origin.helpers';

/**
 * E2E (1-8A) — branding d'organisation + logo tenant, sur
 * `MongoMemoryReplSet` réel (2 organisations A/B). Les opérations S3
 * (`uploadValidatedImage`/`deleteStoredKey`) sont ESPIONNÉES (jamais overridées
 * en provider) : même convention que `multitenant-isolation.e2e-spec.ts`
 * (§3) — aucun appel réseau réel, la logique HTTP+DB reste réellement
 * exercée.
 */

const TEST_JWT_SECRET = 'branding-e2e-only-secret';
const E2E_CORS_ORIGIN = 'https://branding-e2e.example.com';
const PASSWORD = 'branding-18a-pw-!1x';

const OWNER_A_EMAIL = 'owner-a-18a@royalvibe.test';
const ADMIN_A_EMAIL = 'admin-a-18a@royalvibe.test';
const SELLER_A_EMAIL = 'seller-a-18a@royalvibe.test';
const DELEGATED_SELLER_A_EMAIL = 'delegated-seller-a-18a@royalvibe.test';
const OWNER_B_EMAIL = 'owner-b-18a@royalvibe.test';

describe('Branding d’organisation + logo tenant (e2e 1-8A)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let userModel: Model<UserDocument>;
  let organizationModel: Model<OrganizationDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let s3Service: S3Service;

  let orgAId = '';
  let orgBId = '';
  let ownerAToken = '';
  let ownerBToken = '';
  let adminAToken = '';
  let sellerAToken = '';
  let delegatedSellerAToken = '';
  // 1-12C : vraie fixture PNG (le contenu est désormais réellement décodé).
  let pngFixture: Buffer = Buffer.alloc(0);

  const getCurrent = (token: string) =>
    request(app.getHttpServer())
      .get('/organizations/current')
      .set('Authorization', `Bearer ${token}`);
  const patchBranding = (
    token: string,
    fields: Record<string, string> = {},
  ) => {
    let req = request(app.getHttpServer())
      .patch('/organizations/current/branding')
      .set('Authorization', `Bearer ${token}`);
    for (const [key, value] of Object.entries(fields)) {
      req = req.field(key, value);
    }
    return req;
  };
  const patchBrandingWithLogo = (
    token: string,
    fields: Record<string, string> = {},
    filename = 'logo.png',
  ) => {
    let req = request(app.getHttpServer())
      .patch('/organizations/current/branding')
      .set('Authorization', `Bearer ${token}`);
    for (const [key, value] of Object.entries(fields)) {
      req = req.field(key, value);
    }
    return req.attach('logo', pngFixture, {
      filename,
      contentType: 'image/png',
    });
  };
  const deleteLogo = (token: string) =>
    request(app.getHttpServer())
      .delete('/organizations/current/logo')
      .set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    pngFixture = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 4,
        background: { r: 255, g: 106, b: 0, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
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
      process.env.CORS_ORIGIN = E2E_CORS_ORIGIN;
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';

      moduleFixture = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleFixture.createNestApplication();
      app.enableCors(
        buildHttpCorsOptions(
          buildOriginAllowlist(parseCORSOrigin(E2E_CORS_ORIGIN, 'development')),
        ),
      );
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      app.useGlobalFilters(new HttpExceptionFilter());
      await app.init();

      userModel = moduleFixture.get(getModelToken('User'));
      organizationModel = moduleFixture.get(getModelToken(Organization.name));
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );
      s3Service = moduleFixture.get(S3Service);

      const regA = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Owner A',
          email: OWNER_A_EMAIL,
          password: PASSWORD,
          organizationName: 'Org A 18A',
        });
      expect(regA.status).toBe(201);
      orgAId = regA.body.organization._id as string;

      const regB = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Owner B',
          email: OWNER_B_EMAIL,
          password: PASSWORD,
          organizationName: 'Org B 18A',
        });
      expect(regB.status).toBe(201);
      orgBId = regB.body.organization._id as string;

      const loginOwnerA = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: OWNER_A_EMAIL, password: PASSWORD });
      expect(loginOwnerA.status).toBe(201);
      ownerAToken = loginOwnerA.body.access_token as string;

      const loginOwnerB = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: OWNER_B_EMAIL, password: PASSWORD });
      expect(loginOwnerB.status).toBe(201);
      ownerBToken = loginOwnerB.body.access_token as string;

      const adminA = await userModel.create({
        name: 'Admin A',
        email: ADMIN_A_EMAIL,
        password: await bcrypt.hash(PASSWORD, 10),
      });
      await membershipModel.create({
        organizationId: new Types.ObjectId(orgAId),
        userId: adminA._id,
        role: 'admin',
        status: 'active',
      });
      const sellerA = await userModel.create({
        name: 'Seller A',
        email: SELLER_A_EMAIL,
        password: await bcrypt.hash(PASSWORD, 10),
      });
      await membershipModel.create({
        organizationId: new Types.ObjectId(orgAId),
        userId: sellerA._id,
        role: 'seller',
        status: 'active',
      });
      const delegatedSellerA = await userModel.create({
        name: 'Delegated Seller A',
        email: DELEGATED_SELLER_A_EMAIL,
        password: await bcrypt.hash(PASSWORD, 10),
      });
      await membershipModel.create({
        organizationId: new Types.ObjectId(orgAId),
        userId: delegatedSellerA._id,
        role: 'seller',
        status: 'active',
        permissions: ['branding.manage'],
      });

      const loginAdminA = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: ADMIN_A_EMAIL,
          password: PASSWORD,
          organizationId: orgAId,
        });
      expect(loginAdminA.status).toBe(201);
      adminAToken = loginAdminA.body.access_token as string;

      const loginSellerA = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: SELLER_A_EMAIL,
          password: PASSWORD,
          organizationId: orgAId,
        });
      expect(loginSellerA.status).toBe(201);
      sellerAToken = loginSellerA.body.access_token as string;

      const loginDelegatedSellerA = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: DELEGATED_SELLER_A_EMAIL,
          password: PASSWORD,
          organizationId: orgAId,
        });
      expect(loginDelegatedSellerA.status).toBe(201);
      delegatedSellerAToken = loginDelegatedSellerA.body.access_token as string;
    } catch (err) {
      if (moduleFixture) await moduleFixture.close().catch(() => undefined);
      await stopEphemeralMongoSafe();
      throw err;
    }
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  it('GET /organizations/current : owner (rôle, jamais via permissions) accède aussi sans permission déclarée', async () => {
    const res = await getCurrent(ownerAToken);
    expect(res.status).toBe(200);
    expect(res.body._id).toBe(orgAId);
  });

  it('GET /organizations/current : vue minimale, défaut #FF6A00, jamais logoKey, accessible sans permission', async () => {
    const res = await getCurrent(sellerAToken);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        '_id',
        'name',
        'slug',
        'brandColor',
        'currency',
        'status',
        'logoUrl',
      ].sort(),
    );
    expect(res.body.brandColor).toBe('#FF6A00');
    expect(res.body.logoUrl).toBeNull();
    expect(res.body._id).toBe(orgAId);
  });

  it('sans token → 401', async () => {
    const res = await request(app.getHttpServer()).get(
      '/organizations/current',
    );
    expect(res.status).toBe(401);
  });

  it('PATCH branding : seller sans délégation → 403 PERMISSION_DENIED', async () => {
    const res = await patchBranding(sellerAToken, { name: 'Piraté' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('DELETE logo : seller sans délégation → 403 PERMISSION_DENIED', async () => {
    const res = await deleteLogo(sellerAToken);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('PATCH branding : admin (permission par défaut) → 200', async () => {
    const res = await patchBranding(adminAToken, { name: 'Org A 18A (admin)' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Org A 18A (admin)');
  });

  it('GET current : seller délégué branding.manage → 200 (même contrat que tout membre actif)', async () => {
    const res = await getCurrent(delegatedSellerAToken);
    expect(res.status).toBe(200);
    expect(res.body._id).toBe(orgAId);
  });

  it('PATCH branding : seller délégué branding.manage → 200, agit dans SON org uniquement', async () => {
    const res = await patchBranding(delegatedSellerAToken, {
      brandColor: '#062B5C',
    });
    expect(res.status).toBe(200);
    expect(res.body.brandColor).toBe('#062B5C');
    expect(res.body._id).toBe(orgAId);
  });

  it('DELETE logo : seller délégué branding.manage → 200', async () => {
    const deleteSpy = jest
      .spyOn(s3Service, 'deleteStoredKey')
      .mockResolvedValue(undefined);
    const res = await deleteLogo(delegatedSellerAToken);
    expect(res.status).toBe(200);
    deleteSpy.mockRestore();
  });

  it('body vide sans logo → 400 EMPTY_BRANDING_UPDATE', async () => {
    const res = await patchBranding(adminAToken, {});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMPTY_BRANDING_UPDATE');
  });

  it('name vide (après trim) → 400', async () => {
    const res = await patchBranding(adminAToken, { name: '   ' });
    expect(res.status).toBe(400);
  });

  it('brandColor invalide (pas #RRGGBB) → 400', async () => {
    const res = await patchBranding(adminAToken, { brandColor: 'orange' });
    expect(res.status).toBe(400);
  });

  it('falsification slug/currency/status/logoKey/organizationId dans le body → 400 (whitelist), organisation A inchangée', async () => {
    const before = await organizationModel.findById(orgAId).exec();
    const res = await patchBranding(adminAToken, {
      slug: 'stolen-slug',
      currency: 'EUR',
      status: 'suspended',
      logoKey: 'organizations/forged/branding/x.png',
      organizationId: orgBId,
    });
    expect(res.status).toBe(400);
    const after = await organizationModel.findById(orgAId).exec();
    expect(after!.slug).toBe(before!.slug);
    expect(after!.status).toBe(before!.status);
    expect(after!.logoKey).toBe(before!.logoKey);
  });

  describe('cycle logo (S3Service espionné, aucun réseau réel)', () => {
    it('upload réussi : clé sous le préfixe tenant EXACT, logoUrl calculée', async () => {
      const uploadSpy = jest
        .spyOn(s3Service, 'uploadValidatedImage')
        .mockResolvedValue({
          key: `organizations/${orgAId}/branding/first.png`,
          url: `http://s3-e2e/organizations/${orgAId}/branding/first.png`,
        });
      const deleteSpy = jest
        .spyOn(s3Service, 'deleteStoredKey')
        .mockResolvedValue(undefined);

      const res = await patchBrandingWithLogo(adminAToken, {}, 'first.png');
      expect(res.status).toBe(200);
      expect(uploadSpy).toHaveBeenCalledWith(
        expect.any(Buffer),
        `organizations/${orgAId}/branding`,
        { format: 'png', extension: 'png', contentType: 'image/png' },
      );
      // `logoUrl` est DÉRIVÉE de `logoKey` via `publicUrlForKey` (config S3
      // réelle) — jamais l'`url` renvoyée par `uploadValidatedImage` (espionné).
      expect(res.body.logoUrl).toBe(
        `http://127.0.0.1:65535/e2e-local/organizations/${orgAId}/branding/first.png`,
      );
      // Aucun logo préexistant : aucune suppression.
      expect(deleteSpy).not.toHaveBeenCalled();

      const stored = await organizationModel.findById(orgAId).exec();
      expect(stored!.logoKey).toBe(
        `organizations/${orgAId}/branding/first.png`,
      );

      uploadSpy.mockRestore();
      deleteSpy.mockRestore();
    });

    it('nouveau logo : l’ANCIEN est supprimé APRÈS la sauvegarde, sous le préfixe tenant', async () => {
      const uploadSpy = jest
        .spyOn(s3Service, 'uploadValidatedImage')
        .mockResolvedValue({
          key: `organizations/${orgAId}/branding/second.png`,
          url: `http://s3-e2e/organizations/${orgAId}/branding/second.png`,
        });
      const deleteSpy = jest
        .spyOn(s3Service, 'deleteStoredKey')
        .mockResolvedValue(undefined);

      const res = await patchBrandingWithLogo(adminAToken, {}, 'second.png');
      expect(res.status).toBe(200);
      expect(deleteSpy).toHaveBeenCalledWith(
        `organizations/${orgAId}/branding/first.png`,
        `organizations/${orgAId}/branding`,
      );

      uploadSpy.mockRestore();
      deleteSpy.mockRestore();
    });

    it('DELETE logo : logoKey → null, ancien objet tenant supprimé', async () => {
      const deleteSpy = jest
        .spyOn(s3Service, 'deleteStoredKey')
        .mockResolvedValue(undefined);

      const res = await deleteLogo(adminAToken);
      expect(res.status).toBe(200);
      expect(res.body.logoUrl).toBeNull();
      expect(deleteSpy).toHaveBeenCalledWith(
        `organizations/${orgAId}/branding/second.png`,
        `organizations/${orgAId}/branding`,
      );

      const stored = await organizationModel.findById(orgAId).exec();
      expect(stored!.logoKey).toBeNull();

      deleteSpy.mockRestore();
    });

    it('DELETE logo sans logo préexistant : no-op DB, aucun appel S3', async () => {
      const deleteSpy = jest
        .spyOn(s3Service, 'deleteStoredKey')
        .mockResolvedValue(undefined);
      const res = await deleteLogo(adminAToken);
      expect(res.status).toBe(200);
      expect(deleteSpy).not.toHaveBeenCalled();
      deleteSpy.mockRestore();
    });
  });

  it('isolation A/B : les mutations de branding de A ne modifient jamais l’organisation B', async () => {
    const beforeB = await organizationModel.findById(orgBId).exec();
    const res = await patchBranding(adminAToken, { name: 'A modifiée encore' });
    expect(res.status).toBe(200);
    const afterB = await organizationModel.findById(orgBId).exec();
    expect(afterB!.name).toBe(beforeB!.name);
    expect(afterB!.brandColor).toBe(beforeB!.brandColor);

    const currentB = await getCurrent(ownerBToken);
    expect(currentB.status).toBe(200);
    expect(currentB.body._id).toBe(orgBId);
    expect(currentB.body.name).not.toBe(res.body.name);
  });

  // ─── 1-12C : noms + contrat logo ──────────────────────────────────────────
  describe('1-12C — validation des noms', () => {
    const register = (body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .post('/auth/register')
        .send({ password: PASSWORD, ...body });
    let seq = 0;
    const email = () => `names-${++seq}-112c@royalvibe.test`;

    it('inscription : organisation 60 → 201 ; 61 → 400', async () => {
      const ok = await register({
        name: 'Awa',
        email: email(),
        organizationName: 'o'.repeat(60),
      });
      expect(ok.status).toBe(201);
      expect(ok.body.organization.name).toBe('o'.repeat(60));
      const ko = await register({
        name: 'Awa',
        email: email(),
        organizationName: 'o'.repeat(61),
      });
      expect(ko.status).toBe(400);
    });

    it('inscription : utilisateur 80 → 201 ; 81 → 400', async () => {
      const ok = await register({
        name: 'u'.repeat(80),
        email: email(),
        organizationName: 'Org 80',
      });
      expect(ok.status).toBe(201);
      expect(ok.body.user.name).toBe('u'.repeat(80));
      const ko = await register({
        name: 'u'.repeat(81),
        email: email(),
        organizationName: 'Org 81',
      });
      expect(ko.status).toBe(400);
    });

    it('inscription : trim persistant, Unicode/accents acceptés', async () => {
      const addr = email();
      const res = await register({
        name: '  Zoé   Ñandú  ',
        email: addr,
        organizationName: '  Épicerie du Coin — 李小龙  ',
      });
      expect(res.status).toBe(201);
      const user = await userModel.findOne({ email: addr }).exec();
      expect(user!.name).toBe('Zoé   Ñandú');
      const org = await organizationModel
        .findById(res.body.organization._id as string)
        .exec();
      expect(org!.name).toBe('Épicerie du Coin — 李小龙');
    });

    it('inscription : espaces seuls → 400 (nom et organisation), aucun compte créé', async () => {
      const a = email();
      const b = email();
      expect(
        (await register({ name: '   ', email: a, organizationName: 'Org' }))
          .status,
      ).toBe(400);
      expect(
        (await register({ name: 'Awa', email: b, organizationName: ' \t ' }))
          .status,
      ).toBe(400);
      expect(await userModel.countDocuments({ email: { $in: [a, b] } })).toBe(
        0,
      );
    });

    it('inscription : whitelist stricte toujours active', async () => {
      const res = await register({
        name: 'Awa',
        email: email(),
        organizationName: 'Org',
        slug: 'forged',
      });
      expect(res.status).toBe(400);
    });

    it('acceptation d’invitation (nouveau compte) : 80 → 201 trimé ; 81 et espaces → 400', async () => {
      const issue = async (to: string) => {
        const res = await request(app.getHttpServer())
          .post('/organizations/invitations')
          .set('Authorization', `Bearer ${ownerAToken}`)
          .send({ email: to, role: 'seller' });
        expect(res.status).toBe(201);
        return res.body.token as string;
      };
      const accept = (token: string, name: string) =>
        request(app.getHttpServer())
          .post('/auth/invitations/accept')
          .send({ token, name, password: PASSWORD });

      const t81 = await issue(email());
      expect((await accept(t81, 'u'.repeat(81))).status).toBe(400);
      const tBlank = await issue(email());
      expect((await accept(tBlank, '    ')).status).toBe(400);

      const addr = email();
      const t80 = await issue(addr);
      const ok = await accept(t80, `  ${'é'.repeat(80)}  `);
      expect(ok.status).toBe(200);
      const user = await userModel.findOne({ email: addr }).exec();
      expect(user!.name).toBe('é'.repeat(80));
    });

    it('branding : 60 → 200 trimé ; 61 → 400 ; nom inchangé après refus', async () => {
      const ok = await patchBranding(adminAToken, {
        name: `  ${'A'.repeat(60)}  `,
      });
      expect(ok.status).toBe(200);
      expect(ok.body.name).toBe('A'.repeat(60));
      const ko = await patchBranding(adminAToken, { name: 'A'.repeat(61) });
      expect(ko.status).toBe(400);
      const stored = await organizationModel.findById(orgAId).exec();
      expect(stored!.name).toBe('A'.repeat(60));
      await patchBranding(adminAToken, { name: 'Org A 18A' });
    });
  });

  describe('1-12C — compatibilité historique (aucune migration)', () => {
    const LEGACY_ORG_NAME = `Organisation historique ${'L'.repeat(76)}`;
    const LEGACY_USER_NAME = `Utilisateur historique ${'U'.repeat(77)}`;

    beforeAll(async () => {
      // Écriture directe hors validateurs : simule un document antérieur aux
      // limites 1-12C (100 caractères).
      await organizationModel.collection.updateOne(
        { _id: new Types.ObjectId(orgAId) },
        { $set: { name: LEGACY_ORG_NAME } },
      );
      await userModel.collection.updateOne(
        { email: ADMIN_A_EMAIL },
        { $set: { name: LEGACY_USER_NAME } },
      );
    });

    afterAll(async () => {
      await organizationModel.collection.updateOne(
        { _id: new Types.ObjectId(orgAId) },
        { $set: { name: 'Org A 18A' } },
      );
    });

    it('lecture : nom d’organisation de 100 caractères renvoyé complet, sans troncature', async () => {
      expect(LEGACY_ORG_NAME.length).toBe(100);
      const res = await getCurrent(adminAToken);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe(LEGACY_ORG_NAME);
    });

    it('lecture : utilisateur historique de 100 caractères — connexion et /auth/me OK', async () => {
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: ADMIN_A_EMAIL, password: PASSWORD });
      expect(login.status).toBe(201);
      const token = login.body.access_token as string;
      const me = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`);
      expect(me.status).toBe(200);
      expect(me.body.name).toBe(LEGACY_USER_NAME);
    });

    it('modification INDÉPENDANTE : brandColor seule → 200, nom historique intact', async () => {
      const res = await patchBranding(adminAToken, { brandColor: '#123456' });
      expect(res.status).toBe(200);
      expect(res.body.brandColor).toBe('#123456');
      const stored = await organizationModel.findById(orgAId).exec();
      expect(stored!.name).toBe(LEGACY_ORG_NAME);
    });

    it('modification INDÉPENDANTE : logo seul puis suppression du logo → 200, nom intact', async () => {
      const uploadSpy = jest
        .spyOn(s3Service, 'uploadValidatedImage')
        .mockResolvedValue({
          key: `organizations/${orgAId}/branding/legacy.png`,
          url: 'unused',
        });
      const deleteSpy = jest
        .spyOn(s3Service, 'deleteStoredKey')
        .mockResolvedValue(undefined);
      expect((await patchBrandingWithLogo(adminAToken)).status).toBe(200);
      expect((await deleteLogo(adminAToken)).status).toBe(200);
      const stored = await organizationModel.findById(orgAId).exec();
      expect(stored!.name).toBe(LEGACY_ORG_NAME);
      expect(stored!.logoKey).toBeNull();
      uploadSpy.mockRestore();
      deleteSpy.mockRestore();
    });

    it('renommer une organisation historique : le NOUVEAU nom reste soumis à la limite de 60', async () => {
      expect(
        (await patchBranding(adminAToken, { name: 'N'.repeat(61) })).status,
      ).toBe(400);
      const stored = await organizationModel.findById(orgAId).exec();
      expect(stored!.name).toBe(LEGACY_ORG_NAME);
    });
  });

  describe('1-12C — contrat du logo (validation réelle Sharp, S3 client espionné)', () => {
    type SendSpy = jest.SpyInstance<Promise<unknown>, [unknown]>;
    let send: SendSpy;
    const s3Client = () =>
      (s3Service as unknown as { s3Client: { send: (c: unknown) => unknown } })
        .s3Client;
    const commandInputs = () =>
      send.mock.calls.map(
        ([command]) => (command as { input: Record<string, unknown> }).input,
      );

    const fixture = (width: number, height: number) =>
      sharp({
        create: {
          width,
          height,
          channels: 4,
          background: { r: 6, g: 43, b: 92, alpha: 1 },
        },
      });
    const upload = (
      body: Buffer,
      filename: string,
      contentType: string,
      token = adminAToken,
    ) =>
      request(app.getHttpServer())
        .patch('/organizations/current/branding')
        .set('Authorization', `Bearer ${token}`)
        .attach('logo', body, { filename, contentType });

    let webp: Buffer;
    beforeAll(async () => {
      webp = await fixture(40, 20).webp().toBuffer();
    });
    beforeEach(() => {
      send = jest
        .spyOn(s3Client() as { send: () => Promise<unknown> }, 'send')
        .mockResolvedValue({}) as unknown as SendSpy;
    });
    afterEach(() => send.mockRestore());

    const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

    it('PNG valide → clé `<uuid>.png` sous le préfixe tenant, ContentType serveur, octets inchangés', async () => {
      const res = await upload(pngFixture, 'Mon Logo (final).PNG', 'image/png');
      expect(res.status).toBe(200);
      const [put] = commandInputs();
      expect(put.Key).toMatch(
        new RegExp(`^organizations/${orgAId}/branding/${UUID}\\.png$`),
      );
      expect(put.ContentType).toBe('image/png');
      expect(Buffer.compare(put.Body as Buffer, pngFixture)).toBe(0);
      expect(String(put.Key)).not.toContain('Mon');
      expect(JSON.stringify(res.body)).not.toContain('logoKey');
      const stored = await organizationModel.findById(orgAId).exec();
      expect(stored!.logoKey).toBe(put.Key);
    });

    it('WebP valide → clé `<uuid>.webp`, ContentType image/webp ; l’ancien logo est supprimé APRÈS la mutation DB', async () => {
      const before = (await organizationModel.findById(orgAId).exec())!.logoKey;
      let logoKeyAtDelete: string | null | undefined;
      send.mockImplementation(async (command: unknown) => {
        if (
          (command as { constructor: { name: string } }).constructor.name ===
          'DeleteObjectCommand'
        ) {
          logoKeyAtDelete = (await organizationModel.findById(orgAId).exec())!
            .logoKey;
        }
        return {};
      });
      const res = await upload(webp, 'logo.webp', 'image/webp');
      expect(res.status).toBe(200);
      const [put, del] = commandInputs();
      expect(put.Key).toMatch(
        new RegExp(`^organizations/${orgAId}/branding/${UUID}\\.webp$`),
      );
      expect(put.ContentType).toBe('image/webp');
      expect(del.Key).toBe(before);
      // Au moment de la suppression, la DB pointe DÉJÀ vers le nouveau logo.
      expect(logoKeyAtDelete).toBe(put.Key);
    });

    it('échec DB après upload → le NOUVEAU fichier est supprimé, l’ancien conservé', async () => {
      const before = (await organizationModel.findById(orgAId).exec())!.logoKey;
      const failing = jest
        .spyOn(OrganizationsService.prototype, 'updateBranding')
        .mockRejectedValueOnce(new Error('db down'));
      const res = await upload(pngFixture, 'logo.png', 'image/png');
      expect(res.status).toBe(500);
      const [put, del] = commandInputs();
      expect(del.Key).toBe(put.Key);
      expect(del.Key).not.toBe(before);
      expect((await organizationModel.findById(orgAId).exec())!.logoKey).toBe(
        before,
      );
      failing.mockRestore();
    });

    const rejected: Array<{
      label: string;
      status: number;
      code: string;
      build: () => [Buffer, string, string] | Promise<[Buffer, string, string]>;
    }> = [
      {
        label: 'PNG renommé .webp',
        status: 400,
        code: 'LOGO_INVALID_FORMAT',
        build: () => [pngFixture, 'logo.webp', 'image/webp'],
      },
      {
        label: 'MIME falsifié',
        status: 400,
        code: 'LOGO_INVALID_FORMAT',
        build: () => [pngFixture, 'logo.png', 'image/webp'],
      },
      {
        label: 'texte déclaré image/png',
        status: 400,
        code: 'LOGO_INVALID_FILE',
        build: () => [
          Buffer.from('not an image at all'),
          'logo.png',
          'image/png',
        ],
      },
      {
        label: 'fichier vide',
        status: 400,
        code: 'LOGO_INVALID_FILE',
        build: () => [Buffer.alloc(0), 'logo.png', 'image/png'],
      },
      {
        label: 'PNG tronqué',
        status: 400,
        code: 'LOGO_INVALID_FILE',
        build: () => [
          pngFixture.subarray(0, pngFixture.length - 20),
          'logo.png',
          'image/png',
        ],
      },
      {
        label: 'largeur 2049',
        status: 400,
        code: 'LOGO_INVALID_DIMENSIONS',
        build: async () => [
          await fixture(2049, 1).png().toBuffer(),
          'logo.png',
          'image/png',
        ],
      },
      {
        label: 'hauteur 2049',
        status: 400,
        code: 'LOGO_INVALID_DIMENSIONS',
        build: async () => [
          await fixture(1, 2049).webp().toBuffer(),
          'logo.webp',
          'image/webp',
        ],
      },
      {
        label: 'SVG',
        status: 400,
        code: 'LOGO_INVALID_FORMAT',
        build: () => [
          Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
          ),
          'logo.svg',
          'image/svg+xml',
        ],
      },
      {
        label: 'JPEG réel',
        status: 400,
        code: 'LOGO_INVALID_FORMAT',
        build: async () => [
          await fixture(8, 8).jpeg().toBuffer(),
          'logo.jpg',
          'image/jpeg',
        ],
      },
      {
        label: 'GIF réel',
        status: 400,
        code: 'LOGO_INVALID_FORMAT',
        build: async () => [
          await fixture(8, 8).gif().toBuffer(),
          'logo.gif',
          'image/gif',
        ],
      },
      {
        label: 'JPEG déguisé en PNG',
        status: 400,
        code: 'LOGO_INVALID_FILE',
        build: async () => [
          await fixture(8, 8).jpeg().toBuffer(),
          'logo.png',
          'image/png',
        ],
      },
      {
        label: '> 2 Mio',
        status: 413,
        code: 'LOGO_TOO_LARGE',
        build: () => [
          Buffer.concat([pngFixture, Buffer.alloc(2 * 1024 * 1024)]),
          'logo.png',
          'image/png',
        ],
      },
    ];

    it.each(rejected)(
      'refus $label → HTTP $status $code, zéro appel S3, zéro écriture DB, aucune fuite interne',
      async ({ status, code, build }) => {
        const before = await organizationModel.findById(orgAId).lean().exec();
        const [body, filename, contentType] = await build();
        const res = await upload(body, filename, contentType);
        expect(res.status).toBe(status);
        expect(res.body.code).toBe(code);
        expect(typeof res.body.message).toBe('string');
        expect(send).not.toHaveBeenCalled();
        const after = await organizationModel.findById(orgAId).lean().exec();
        expect(after!.logoKey).toBe(before!.logoKey);
        expect(after!.updatedAt).toEqual(before!.updatedAt);
        const raw = JSON.stringify(res.body);
        // `path` (route publique) est ajouté par le filtre existant ; jamais
        // de clé de stockage tenant, de chemin local ni de détail interne.
        expect(raw).not.toMatch(
          /organizations\/[0-9a-f]{24}|stack|\\\\|[A-Z]:\/|sharp|vips|\.tmp/i,
        );
      },
    );

    it('exactement 2048 × 2048 → accepté', async () => {
      const max = await fixture(2048, 2048).png().toBuffer();
      const res = await upload(max, 'max.png', 'image/png');
      expect(res.status).toBe(200);
    });

    it('isolation : logo de B sous le préfixe de B uniquement, A inchangée', async () => {
      const aBefore = (await organizationModel.findById(orgAId).exec())!
        .logoKey;
      const res = await upload(pngFixture, 'b.png', 'image/png', ownerBToken);
      expect(res.status).toBe(200);
      for (const input of commandInputs()) {
        expect(String(input.Key)).toMatch(
          new RegExp(`^organizations/${orgBId}/branding/`),
        );
      }
      expect((await organizationModel.findById(orgAId).exec())!.logoKey).toBe(
        aBefore,
      );
    });

    it('suppression de logo inchangée : DB à null puis objet tenant supprimé', async () => {
      const before = (await organizationModel.findById(orgAId).exec())!.logoKey;
      const res = await deleteLogo(adminAToken);
      expect(res.status).toBe(200);
      expect(res.body.logoUrl).toBeNull();
      expect(commandInputs().map((i) => i.Key)).toEqual([before]);
    });

    it('images produits inchangées : JPEG accepté via `uploadFile`, jamais le contrat logo', async () => {
      const section = await request(app.getHttpServer())
        .post('/sections')
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ name: 'Rayon 1-12C' });
      expect(section.status).toBe(201);
      const uploadFile = jest.spyOn(s3Service, 'uploadFile');
      const validated = jest.spyOn(s3Service, 'uploadValidatedImage');
      const jpeg = await fixture(16, 16).jpeg().toBuffer();
      const res = await request(app.getHttpServer())
        .post('/products')
        .set('Authorization', `Bearer ${adminAToken}`)
        .field('sectionId', section.body._id as string)
        .field('name', 'Produit 1-12C')
        .field('purchasePrice', '100')
        .field('salePrice', '200')
        .field('initialQuantity', '3')
        .attach('image', jpeg, {
          filename: 'photo.jpg',
          contentType: 'image/jpeg',
        });
      expect(res.status).toBe(201);
      expect(uploadFile).toHaveBeenCalledTimes(1);
      expect(validated).not.toHaveBeenCalled();
      const [put] = commandInputs();
      expect(put.ContentType).toBe('image/jpeg');
      expect(String(put.Key)).toMatch(/photo\.jpg$/);
      uploadFile.mockRestore();
      validated.mockRestore();
    });
  });

  describe('garde OrganizationGuard (membre/organisation inactifs)', () => {
    // Token émis pendant que la membership était encore active : la garde
    // relit systématiquement l'état courant à CHAQUE requête (jamais un
    // simple contrôle au login) — un token « périmé » doit donc être
    // refusé dès la suspension, sans réémission.
    it('membership suspendue APRÈS l’émission du token → 403, GET current refusé sur les 3 routes', async () => {
      const staleUser = await userModel.create({
        name: 'Stale Seller A',
        email: 'stale-seller-a-18a@royalvibe.test',
        password: await bcrypt.hash(PASSWORD, 10),
      });
      await membershipModel.create({
        organizationId: new Types.ObjectId(orgAId),
        userId: staleUser._id,
        role: 'seller',
        status: 'active',
        permissions: ['branding.manage'],
      });
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'stale-seller-a-18a@royalvibe.test',
          password: PASSWORD,
          organizationId: orgAId,
        });
      expect(login.status).toBe(201);
      const staleToken = login.body.access_token as string;

      await membershipModel.updateOne(
        { organizationId: new Types.ObjectId(orgAId), userId: staleUser._id },
        { status: 'suspended' },
      );

      const getRes = await getCurrent(staleToken);
      expect(getRes.status).toBe(403);
      expect(getRes.body.code).toBe('ORGANIZATION_ACCESS_DENIED');

      const patchRes = await patchBranding(staleToken, { name: 'X' });
      expect(patchRes.status).toBe(403);
      expect(patchRes.body.code).toBe('ORGANIZATION_ACCESS_DENIED');

      const deleteRes = await deleteLogo(staleToken);
      expect(deleteRes.status).toBe(403);
      expect(deleteRes.body.code).toBe('ORGANIZATION_ACCESS_DENIED');
    });

    it('organisation suspendue → 403 sur GET current, même pour l’owner', async () => {
      await organizationModel.updateOne(
        { _id: new Types.ObjectId(orgAId) },
        { status: 'suspended' },
      );
      try {
        const res = await getCurrent(ownerAToken);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ORGANIZATION_ACCESS_DENIED');
      } finally {
        // Restauration : d'autres tests de ce fichier réutilisent org A.
        await organizationModel.updateOne(
          { _id: new Types.ObjectId(orgAId) },
          { status: 'active' },
        );
      }
    });
  });
});
