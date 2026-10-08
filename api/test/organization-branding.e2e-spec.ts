import 'reflect-metadata';
import { Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import * as http from 'http';
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
import { isSharpSecurityPolicyConfigured } from './../src/common/image/sharp-security-policy';
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
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import {
  E2E_EMAIL_VERIFIED_AT,
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';
import { INVITATION_TERMS, OWNER_TERMS } from './e2e/legal-acceptance-fixtures';

// 1-13A : expéditeur simulé, liens confirmés via le service réel.
const emailSender = createE2eEmailSender();

/**
 * E2E (1-8A) — branding d'organisation + logo tenant, sur
 * `MongoMemoryReplSet` réel (2 organisations A/B). Les opérations S3
 * (`uploadValidatedImage`/`deleteStoredObject`) sont ESPIONNÉES (jamais overridées
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
      process.env.PUBLIC_APP_URL = 'https://app.branding-e2e.test';
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';

      moduleFixture = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(EMAIL_SENDER)
        .useValue(emailSender)
        .compile();
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
      autoConfirmVerificationEmails(app, emailSender);

      userModel = moduleFixture.get(getModelToken('User'));
      organizationModel = moduleFixture.get(getModelToken(Organization.name));
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );
      s3Service = moduleFixture.get(S3Service);

      const regA = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          ...OWNER_TERMS,
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
          ...OWNER_TERMS,
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
        emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
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
        emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
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
        emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
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
      .spyOn(s3Service, 'deleteStoredObject')
      .mockResolvedValue('deleted');
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
    it('upload réussi : clé + stockage sous le préfixe tenant EXACT, logoUrl signée', async () => {
      const uploadSpy = jest
        .spyOn(s3Service, 'uploadValidatedImage')
        .mockResolvedValue({
          key: `organizations/${orgAId}/branding/first.png`,
          storage: s3Service.storage,
        });
      const deleteSpy = jest
        .spyOn(s3Service, 'deleteStoredObject')
        .mockImplementation((ref) =>
          Promise.resolve(ref ? 'deleted' : 'not_needed'),
        );

      const res = await patchBrandingWithLogo(adminAToken, {}, 'first.png');
      expect(res.status).toBe(200);
      expect(uploadSpy).toHaveBeenCalledWith(
        expect.any(Buffer),
        `organizations/${orgAId}/branding`,
        { format: 'png', extension: 'png', contentType: 'image/png' },
      );
      // `logoUrl` : URL GET SIGNÉE (vraie signature, aucun réseau) calculée
      // à partir de `logoKey` et du stockage, durée explicite.
      const signed = new URL(res.body.logoUrl as string);
      expect(`${signed.origin}${signed.pathname}`).toBe(
        `http://127.0.0.1:65535/e2e-local/organizations/${orgAId}/branding/first.png`,
      );
      expect(signed.searchParams.get('X-Amz-Expires')).toBe('900');
      expect(signed.searchParams.get('X-Amz-Signature')).toMatch(
        /^[0-9a-f]{64}$/,
      );
      expect(res.body).toMatchObject({ storageCleanup: 'not_needed' });
      // Aucun logo préexistant : sort `not_needed`, aucun appel réseau.
      expect(deleteSpy).toHaveBeenCalledWith(
        null,
        `organizations/${orgAId}/branding`,
      );

      const stored = await organizationModel.findById(orgAId).exec();
      expect(stored!.logoKey).toBe(
        `organizations/${orgAId}/branding/first.png`,
      );
      expect(stored!.logoStorage).toBe(s3Service.storage);
      // Jamais d'URL (publique ni signée) en base.
      expect(JSON.stringify(stored!.toObject())).not.toContain('X-Amz');

      uploadSpy.mockRestore();
      deleteSpy.mockRestore();
    });

    it('nouveau logo : l’ANCIEN est supprimé APRÈS la sauvegarde, sous le préfixe tenant', async () => {
      const uploadSpy = jest
        .spyOn(s3Service, 'uploadValidatedImage')
        .mockResolvedValue({
          key: `organizations/${orgAId}/branding/second.png`,
          storage: s3Service.storage,
        });
      const deleteSpy = jest
        .spyOn(s3Service, 'deleteStoredObject')
        .mockResolvedValue('deleted');

      const res = await patchBrandingWithLogo(adminAToken, {}, 'second.png');
      expect(res.status).toBe(200);
      expect(deleteSpy).toHaveBeenCalledWith(
        {
          key: `organizations/${orgAId}/branding/first.png`,
          storage: s3Service.storage,
        },
        `organizations/${orgAId}/branding`,
      );
      expect(res.body.storageCleanup).toBe('deleted');

      uploadSpy.mockRestore();
      deleteSpy.mockRestore();
    });

    it('DELETE logo : logoKey et logoStorage → null, ancien objet tenant supprimé', async () => {
      const deleteSpy = jest
        .spyOn(s3Service, 'deleteStoredObject')
        .mockResolvedValue('deleted');

      const res = await deleteLogo(adminAToken);
      expect(res.status).toBe(200);
      expect(res.body.logoUrl).toBeNull();
      expect(deleteSpy).toHaveBeenCalledWith(
        {
          key: `organizations/${orgAId}/branding/second.png`,
          storage: s3Service.storage,
        },
        `organizations/${orgAId}/branding`,
      );

      const stored = await organizationModel.findById(orgAId).exec();
      expect(stored!.logoKey).toBeNull();
      expect(stored!.logoStorage).toBeNull();

      deleteSpy.mockRestore();
    });

    it('DELETE logo sans logo préexistant : no-op DB, sort `not_needed`, aucun appel réseau', async () => {
      // Comportement réel (non simulé) : aucune référence → aucun envoi.
      const deleteSpy = jest.spyOn(s3Service, 'deleteStoredObject');
      const res = await deleteLogo(adminAToken);
      expect(res.status).toBe(200);
      expect(res.body.storageCleanup).toBe('not_needed');
      expect(deleteSpy).toHaveBeenCalledWith(
        null,
        `organizations/${orgAId}/branding`,
      );
      deleteSpy.mockRestore();
    });

    it('ancien logoKey sans stockage connu (antérieur à R2) : jamais signé ni supprimé', async () => {
      await organizationModel.updateOne(
        { _id: orgAId },
        { $set: { logoKey: `organizations/${orgAId}/branding/legacy.png` } },
      );
      const current = await getCurrent(adminAToken);
      expect(current.status).toBe(200);
      expect(current.body.logoUrl).toBeNull();
      const res = await deleteLogo(adminAToken);
      expect(res.status).toBe(200);
      expect(res.body.storageCleanup).toBe('retained');
      const stored = await organizationModel.findById(orgAId).exec();
      expect(stored!.logoKey).toBeNull();
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
        .send({ ...OWNER_TERMS, password: PASSWORD, ...body });
    let seq = 0;
    const email = () => `names-${++seq}-112c@royalvibe.test`;

    it('inscription : organisation 60 → 201 ; 61 → 400', async () => {
      const ok = await register({
        name: 'Awa',
        email: email(),
        organizationName: 'o'.repeat(20),
      });
      expect(ok.status).toBe(201);
      expect(ok.body.organization.name).toBe('o'.repeat(20));
      const ko = await register({
        name: 'Awa',
        email: email(),
        organizationName: 'o'.repeat(21),
      });
      expect(ko.status).toBe(400);
    });

    it('inscription : utilisateur 80 → 201 ; 81 → 400', async () => {
      const ok = await register({
        name: 'u'.repeat(20),
        email: email(),
        organizationName: 'Org 80',
      });
      expect(ok.status).toBe(201);
      expect(ok.body.user.name).toBe('u'.repeat(20));
      const ko = await register({
        name: 'u'.repeat(21),
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
        organizationName: '  Épicerie 李小龙 №1  ',
      });
      expect(res.status).toBe(201);
      const user = await userModel.findOne({ email: addr }).exec();
      expect(user!.name).toBe('Zoé   Ñandú');
      const org = await organizationModel
        .findById(res.body.organization._id as string)
        .exec();
      expect(org!.name).toBe('Épicerie 李小龙 №1');
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
        return (
          new URL(res.body.invitationUrl as string).searchParams.get('token') ??
          ''
        );
      };
      const accept = (token: string, name: string) =>
        request(app.getHttpServer())
          .post('/auth/invitations/accept')
          .send({ ...INVITATION_TERMS, token, name, password: PASSWORD });

      const t81 = await issue(email());
      expect((await accept(t81, 'u'.repeat(21))).status).toBe(400);
      const tBlank = await issue(email());
      expect((await accept(tBlank, '    ')).status).toBe(400);

      const addr = email();
      const t80 = await issue(addr);
      const ok = await accept(t80, `  ${'é'.repeat(20)}  `);
      expect(ok.status).toBe(200);
      const user = await userModel.findOne({ email: addr }).exec();
      expect(user!.name).toBe('é'.repeat(20));
    });

    it('branding : 60 → 200 trimé ; 61 → 400 ; nom inchangé après refus', async () => {
      const ok = await patchBranding(adminAToken, {
        name: `  ${'A'.repeat(20)}  `,
      });
      expect(ok.status).toBe(200);
      expect(ok.body.name).toBe('A'.repeat(20));
      const ko = await patchBranding(adminAToken, { name: 'A'.repeat(21) });
      expect(ko.status).toBe(400);
      const stored = await organizationModel.findById(orgAId).exec();
      expect(stored!.name).toBe('A'.repeat(20));
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
          storage: s3Service.storage,
        });
      const deleteSpy = jest
        .spyOn(s3Service, 'deleteStoredObject')
        .mockResolvedValue('deleted');
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
        (await patchBranding(adminAToken, { name: 'N'.repeat(21) })).status,
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

    it('politique Sharp du processus appliquée au bootstrap Nest (app.init) : GIF bloqué, JPEG lisible', async () => {
      expect(isSharpSecurityPolicyConfigured()).toBe(true);
      await expect(
        sharp(await fixture(8, 8).gif().toBuffer()).metadata(),
      ).rejects.toThrow();
      await expect(
        sharp(await fixture(8, 8).jpeg().toBuffer()).metadata(),
      ).resolves.toHaveProperty('format', 'jpeg');
    });

    const storageCases: Array<{
      label: string;
      filename: string;
      mime: string;
      ext: string;
      build: () => Promise<Buffer>;
    }> = [
      {
        label: 'PNG',
        filename: 'Mon Logo.png',
        mime: 'image/png',
        ext: 'png',
        build: () => fixture(48, 24).png().toBuffer(),
      },
      {
        label: 'WebP statique',
        filename: 'Mon Logo.webp',
        mime: 'image/webp',
        ext: 'webp',
        build: () => fixture(48, 24).webp().toBuffer(),
      },
      {
        label: 'JPEG .jpg',
        filename: 'Mon Logo.jpg',
        mime: 'image/jpeg',
        ext: 'jpg',
        build: () => fixture(48, 24).jpeg().toBuffer(),
      },
      {
        label: 'JPEG .jpeg → clé .jpg',
        filename: 'Mon Logo.JPEG',
        mime: 'image/jpeg',
        ext: 'jpg',
        build: () => fixture(48, 24).jpeg().toBuffer(),
      },
    ];

    it.each(storageCases)(
      'stockage $label : clé tenant `<uuid>.$ext`, ContentType serveur, octets identiques, logoUrl dérivée, logoKey jamais exposée',
      async ({ filename, mime, ext, build }) => {
        const body = await build();
        const res = await upload(body, filename, mime);
        expect(res.status).toBe(200);
        const [put] = commandInputs();
        expect(put.Key).toMatch(
          new RegExp(`^organizations/${orgAId}/branding/${UUID}\\.${ext}$`),
        );
        expect(String(put.Key)).not.toMatch(/Mon|Logo|jpeg$/);
        expect(put.ContentType).toBe(mime);
        expect(Buffer.compare(put.Body as Buffer, body)).toBe(0);
        expect(JSON.stringify(res.body)).not.toContain('logoKey');
        const signed = new URL(res.body.logoUrl as string);
        expect(`${signed.origin}${signed.pathname}`).toBe(
          `http://127.0.0.1:65535/e2e-local/${String(put.Key)}`,
        );
        expect(signed.searchParams.get('X-Amz-Expires')).toBe('900');
        const stored = await organizationModel.findById(orgAId).exec();
        expect(stored!.logoKey).toBe(put.Key);
      },
    );

    it('JPEG remplaçant : l’ancien logo est supprimé APRÈS la mutation DB', async () => {
      const before = (await organizationModel.findById(orgAId).exec())!.logoKey;
      expect(before).toBeTruthy();
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
      const res = await upload(
        await fixture(20, 20).jpeg().toBuffer(),
        'nouveau.jpeg',
        'image/jpeg',
      );
      expect(res.status).toBe(200);
      const [put, del] = commandInputs();
      expect(String(put.Key)).toMatch(/\.jpg$/);
      expect(del.Key).toBe(before);
      expect(logoKeyAtDelete).toBe(put.Key);
    });

    it('JPEG + échec DB → le NOUVEAU fichier est supprimé, l’ancien conservé', async () => {
      const before = (await organizationModel.findById(orgAId).exec())!.logoKey;
      const failing = jest
        .spyOn(OrganizationsService.prototype, 'updateBranding')
        .mockRejectedValueOnce(new Error('db down'));
      const res = await upload(
        await fixture(20, 20).jpeg().toBuffer(),
        'logo.jpg',
        'image/jpeg',
      );
      expect(res.status).toBe(500);
      const [put, del] = commandInputs();
      expect(del.Key).toBe(put.Key);
      expect(del.Key).not.toBe(before);
      expect((await organizationModel.findById(orgAId).exec())!.logoKey).toBe(
        before,
      );
      failing.mockRestore();
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
        label: 'AVIF réel',
        status: 400,
        code: 'LOGO_INVALID_FORMAT',
        build: async () => [
          await fixture(8, 8).avif().toBuffer(),
          'logo.avif',
          'image/avif',
        ],
      },
      {
        label: 'HEIF réel déguisé en JPEG',
        status: 400,
        code: 'LOGO_INVALID_FILE',
        build: async () => [
          await fixture(8, 8).heif({ compression: 'av1' }).toBuffer(),
          'logo.jpg',
          'image/jpeg',
        ],
      },
      {
        label: 'TIFF réel',
        status: 400,
        code: 'LOGO_INVALID_FORMAT',
        build: async () => [
          await fixture(8, 8).tiff().toBuffer(),
          'logo.tif',
          'image/tiff',
        ],
      },
      {
        label: 'PNG renommé .jpg',
        status: 400,
        code: 'LOGO_INVALID_FORMAT',
        build: () => [pngFixture, 'logo.jpg', 'image/jpeg'],
      },
      {
        label: 'JPEG tronqué',
        status: 400,
        code: 'LOGO_INVALID_FILE',
        build: async () => {
          const jpeg = await fixture(32, 32).jpeg().toBuffer();
          return [jpeg.subarray(0, jpeg.length - 40), 'logo.jpg', 'image/jpeg'];
        },
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
        code: 'LOGO_INVALID_FORMAT',
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

    it('photos produit (R2) : JPEG contrôlé, clé serveur sous le préfixe tenant, URL signée ; photo invalide refusée sans envoi', async () => {
      const section = await request(app.getHttpServer())
        .post('/sections')
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ name: 'Rayon 1-12C' });
      expect(section.status).toBe(201);
      const jpeg = await fixture(16, 16).jpeg().toBuffer();
      const create = (body: Buffer, name: string, contentType: string) =>
        request(app.getHttpServer())
          .post('/products')
          .set('Authorization', `Bearer ${adminAToken}`)
          .field('sectionId', section.body._id as string)
          .field('name', name)
          .field('purchasePrice', '100')
          .field('salePrice', '200')
          .field('initialQuantity', '3')
          .attach('image', body, { filename: 'photo.jpg', contentType });

      const res = await create(jpeg, 'Produit 1-12C', 'image/jpeg');
      expect(res.status).toBe(201);
      const [put] = commandInputs();
      expect(put.ContentType).toBe('image/jpeg');
      expect(String(put.Key)).toMatch(
        new RegExp(`^organizations/${orgAId}/products/${UUID}\\.jpg$`),
      );
      expect(String(put.Key)).not.toContain('photo');
      const signed = new URL(res.body.imageUrl as string);
      expect(signed.pathname).toBe(`/e2e-local/${String(put.Key)}`);
      expect(signed.searchParams.get('X-Amz-Expires')).toBe('900');

      // Texte déguisé en JPEG : 400 stable, aucun envoi ni écriture.
      send.mockClear();
      const fake = await create(
        Buffer.from('<svg onload="alert(1)">'),
        'Produit faux',
        'image/jpeg',
      );
      expect(fake.status).toBe(400);
      expect(fake.body.code).toBe('PRODUCT_IMAGE_INVALID_FILE');
      expect(send).not.toHaveBeenCalled();
    });
  });

  // ─── 1-12D : multipart malformé (Multer 2.4.0) + logos animés ─────────────
  describe('1-12D — multipart malformé et logos animés (aucun crash, aucune écriture)', () => {
    type SendSpy = jest.SpyInstance<Promise<unknown>, [unknown]>;
    let send: SendSpy;
    let uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    const BOUNDARY = '----stockmaster112d';
    const CRLF = '\r\n';

    const part = (
      name: string,
      value: Buffer | string,
      file?: { filename: string; contentType: string },
    ) =>
      Buffer.concat([
        Buffer.from(
          `--${BOUNDARY}${CRLF}Content-Disposition: form-data; name="${name}"` +
            (file ? `; filename="${file.filename}"` : '') +
            CRLF +
            (file ? `Content-Type: ${file.contentType}${CRLF}` : '') +
            CRLF,
        ),
        Buffer.isBuffer(value) ? value : Buffer.from(value),
        Buffer.from(CRLF),
      ]);
    const close = Buffer.from(`--${BOUNDARY}--${CRLF}`);
    const rawPatch = (body: Buffer) =>
      request(app.getHttpServer())
        .patch('/organizations/current/branding')
        .set('Authorization', `Bearer ${adminAToken}`)
        .set('Content-Type', `multipart/form-data; boundary=${BOUNDARY}`)
        .send(body);
    const png = () => ({ filename: 'logo.png', contentType: 'image/png' });

    let snapshot: { logoKey: string | null; updatedAt: unknown; name: string };
    const takeSnapshot = async () => {
      const doc = await organizationModel.findById(orgAId).lean().exec();
      snapshot = {
        logoKey: doc!.logoKey,
        updatedAt: doc!.updatedAt,
        name: doc!.name,
      };
    };
    const expectNoWrite = async () => {
      expect(send).not.toHaveBeenCalled();
      const doc = await organizationModel.findById(orgAId).lean().exec();
      expect({
        logoKey: doc!.logoKey,
        updatedAt: doc!.updatedAt,
        name: doc!.name,
      }).toEqual(snapshot);
    };
    const expectServerAlive = async () => {
      const res = await getCurrent(adminAToken);
      expect(res.status).toBe(200);
      expect(uncaught).toEqual([]);
    };

    beforeAll(() => process.on('uncaughtException', onUncaught));
    afterAll(() => process.off('uncaughtException', onUncaught));
    beforeEach(async () => {
      uncaught = [];
      send = jest
        .spyOn(
          (
            s3Service as unknown as {
              s3Client: { send: () => Promise<unknown> };
            }
          ).s3Client,
          'send',
        )
        .mockResolvedValue({}) as unknown as SendSpy;
      await takeSnapshot();
    });
    afterEach(() => send.mockRestore());

    it('champ fichier `logo` vide (0 octet) → 400 LOGO_INVALID_FILE', async () => {
      const res = await rawPatch(
        Buffer.concat([part('logo', Buffer.alloc(0), png()), close]),
      );
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('LOGO_INVALID_FILE');
      await expectNoWrite();
      await expectServerAlive();
    });

    it('fichier sous un nom de champ inattendu → 400 contrôlé', async () => {
      const res = await rawPatch(
        Buffer.concat([part('avatar', pngFixture, png()), close]),
      );
      expect(res.status).toBe(400);
      await expectNoWrite();
      await expectServerAlive();
    });

    it('fichier sous un nom de champ VIDE → 400 contrôlé', async () => {
      const res = await rawPatch(
        Buffer.concat([part('', pngFixture, png()), close]),
      );
      expect(res.status).toBe(400);
      await expectNoWrite();
      await expectServerAlive();
    });

    it('champ texte inattendu → 400 (whitelist globale), rien écrit', async () => {
      const res = await rawPatch(
        Buffer.concat([
          part('slug', 'forged'),
          part('brandColor', '#111111'),
          close,
        ]),
      );
      expect(res.status).toBe(400);
      await expectNoWrite();
    });

    it('multipart tronqué (fin de formulaire absente) → 400 contrôlé', async () => {
      const body = Buffer.concat([part('logo', pngFixture, png())]).subarray(
        0,
        60,
      );
      const res = await rawPatch(body);
      expect(res.status).toBe(400);
      await expectNoWrite();
      await expectServerAlive();
    });

    it('champs profondément imbriqués → 400 rapide, aucune boucle CPU', async () => {
      const deep = `a${'[b]'.repeat(500)}`;
      const t0 = Date.now();
      const res = await rawPatch(
        Buffer.concat([part(deep, 'x'), part('brandColor', '#111111'), close]),
      );
      expect(res.status).toBe(400);
      expect(Date.now() - t0).toBeLessThan(5000);
      await expectNoWrite();
      await expectServerAlive();
    });

    it('index de tableau démesuré (GHSA-535w-7cp7-47q4) → 400 rapide, processus vivant', async () => {
      const t0 = Date.now();
      const res = await rawPatch(
        Buffer.concat([
          part('items[4294967294]', 'x'),
          part('items[key]', 'y'),
          close,
        ]),
      );
      expect(res.status).toBe(400);
      expect(Date.now() - t0).toBeLessThan(5000);
      await expectNoWrite();
      await expectServerAlive();
    });

    it('longueur de tableau hors limite (`a[4294967295]`, GHSA-wc9g) → 400, aucune exception non interceptée', async () => {
      const t0 = Date.now();
      const res = await rawPatch(
        Buffer.concat([
          part('a[4294967295]', 'x'),
          part('a[4294967296]', 'y'),
          close,
        ]),
      );
      expect(res.status).toBe(400);
      expect(Date.now() - t0).toBeLessThan(5000);
      await expectNoWrite();
      await expectServerAlive();
    });

    it('même charge GHSA-535w sur POST /products (route produit durcie aussi) → 400 rapide, zéro S3', async () => {
      const t0 = Date.now();
      const res = await request(app.getHttpServer())
        .post('/products')
        .set('Authorization', `Bearer ${adminAToken}`)
        .set('Content-Type', `multipart/form-data; boundary=${BOUNDARY}`)
        .send(
          Buffer.concat([
            part('items[4294967294]', 'x'),
            part('items[key]', 'y'),
            close,
          ]),
        );
      expect(res.status).toBe(400);
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(send).not.toHaveBeenCalled();
      await expectServerAlive();
    });

    it('deux fichiers `logo` alors qu’un seul est autorisé → 400 contrôlé', async () => {
      const res = await rawPatch(
        Buffer.concat([
          part('logo', pngFixture, png()),
          part('logo', pngFixture, png()),
          close,
        ]),
      );
      expect(res.status).toBe(400);
      await expectNoWrite();
      await expectServerAlive();
    });

    it('dépassement de taille → 413 LOGO_TOO_LARGE', async () => {
      const big = Buffer.concat([pngFixture, Buffer.alloc(2 * 1024 * 1024)]);
      const res = await rawPatch(
        Buffer.concat([part('logo', big, png()), close]),
      );
      expect(res.status).toBe(413);
      expect(res.body.code).toBe('LOGO_TOO_LARGE');
      await expectNoWrite();
      await expectServerAlive();
    });

    it('connexion interrompue en plein upload → aucun crash, aucune écriture', async () => {
      const server = app.getHttpServer();
      const listening = server.listening;
      if (!listening) {
        await new Promise<void>((resolve) => server.listen(0, resolve));
      }
      const { port } = server.address() as { port: number };
      const head = part('logo', pngFixture, png());
      await new Promise<void>((resolve) => {
        const req = http.request({
          host: '127.0.0.1',
          port,
          method: 'PATCH',
          path: '/organizations/current/branding',
          headers: {
            Authorization: `Bearer ${adminAToken}`,
            'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
            'Content-Length': String(head.length + 10_000),
          },
        });
        req.on('error', () => resolve());
        req.write(head.subarray(0, Math.floor(head.length / 2)));
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 200);
      });
      await new Promise((r) => setTimeout(r, 300));
      if (!listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await expectNoWrite();
      await expectServerAlive();
    });

    it('WebP animé → 400 LOGO_INVALID_FILE « statique », zéro S3/DB', async () => {
      const frame = (c: string) =>
        sharp({ create: { width: 16, height: 16, channels: 4, background: c } })
          .png()
          .toBuffer();
      const animated = await sharp(
        [await frame('#ff0000'), await frame('#0000ff')],
        {
          join: { animated: true },
        },
      )
        .webp({ loop: 0 })
        .toBuffer();
      const res = await rawPatch(
        Buffer.concat([
          part('logo', animated, {
            filename: 'anim.webp',
            contentType: 'image/webp',
          }),
          close,
        ]),
      );
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        statusCode: 400,
        code: 'LOGO_INVALID_FILE',
        message: 'Le logo doit être une image PNG ou WebP statique valide.',
      });
      await expectNoWrite();
    });

    it('contrôle : un logo PNG statique valide passe toujours (le spy S3 reçoit un seul PUT)', async () => {
      const res = await rawPatch(
        Buffer.concat([part('logo', pngFixture, png()), close]),
      );
      expect(res.status).toBe(200);
      expect(send).toHaveBeenCalled();
    });
  });

  describe('garde OrganizationGuard (membre/organisation inactifs)', () => {
    // Token émis pendant que la membership était encore active : la garde
    // relit systématiquement l'état courant à CHAQUE requête (jamais un
    // simple contrôle au login) — un token « périmé » doit donc être
    // refusé dès la suspension, sans réémission.
    it('membership suspendue APRÈS l’émission du token → 403, GET current refusé sur les 3 routes', async () => {
      const staleUser = await userModel.create({
        emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
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
