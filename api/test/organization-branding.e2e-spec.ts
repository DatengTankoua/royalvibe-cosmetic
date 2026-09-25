import 'reflect-metadata';
import { Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument } from './../src/users/schemas/user.schema';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import { S3Service } from './../src/s3/s3.service';
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
 * (`uploadStoredFile`/`deleteStoredKey`) sont ESPIONNÉES (jamais overridées
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
    return req.attach('logo', Buffer.from('fake-png-bytes'), filename);
  };
  const deleteLogo = (token: string) =>
    request(app.getHttpServer())
      .delete('/organizations/current/logo')
      .set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
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
        .spyOn(s3Service, 'uploadStoredFile')
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
        expect.anything(),
        `organizations/${orgAId}/branding`,
      );
      // `logoUrl` est DÉRIVÉE de `logoKey` via `publicUrlForKey` (config S3
      // réelle) — jamais l'`url` renvoyée par `uploadStoredFile` (espionné).
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
        .spyOn(s3Service, 'uploadStoredFile')
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
