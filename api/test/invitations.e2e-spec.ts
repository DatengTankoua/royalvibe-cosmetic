import 'reflect-metadata';
import { createHash } from 'crypto';
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
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import { OrganizationInvitation } from './../src/organizations/schemas/invitation.schema';
import type { OrganizationInvitationDocument } from './../src/organizations/schemas/invitation.schema';
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
 * E2E (1-6B.1) — émission/liste/révocation d'invitations tenant-scopées,
 * sur `MongoMemoryReplSet` réel (2 organisations A/B, aucun mock de driver).
 */

const TEST_JWT_SECRET = 'invitations-e2e-only-static-secret';
const E2E_CORS_ORIGIN = 'https://invitations-e2e.example.com';

const OWNER_A_EMAIL = 'owner-a-16b1@royalvibe.test';
const OWNER_B_EMAIL = 'owner-b-16b1@royalvibe.test';
const ADMIN_A_EMAIL = 'admin-a-16b1@royalvibe.test';
const SELLER_A_EMAIL = 'seller-a-16b1@royalvibe.test';
const PASSWORD = 'owner-16b1-pw-!1x';

describe('Invitations (e2e 1-6B.1) — émission sécurisée, isolation A/B', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;

  let userModel: Model<UserDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let invitationModel: Model<OrganizationInvitationDocument>;

  let orgAId = '';
  let orgBId = '';
  let ownerAToken = '';
  let ownerBToken = '';
  let adminAToken = '';
  let sellerAToken = '';

  const invite = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/organizations/invitations')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const list = (token: string) =>
    request(app.getHttpServer())
      .get('/organizations/invitations')
      .set('Authorization', `Bearer ${token}`);
  const revoke = (token: string, id: string) =>
    request(app.getHttpServer())
      .post(`/organizations/invitations/${id}/revoke`)
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
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );
      invitationModel = moduleFixture.get(
        getModelToken(OrganizationInvitation.name),
      );

      // ---- Owner A + Owner B : onboarding atomique réel (1-6A) ----
      const regA = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Owner A',
          email: OWNER_A_EMAIL,
          password: PASSWORD,
          organizationName: 'Org A 16B1',
        });
      expect(regA.status).toBe(201);
      orgAId = regA.body.organization._id as string;

      const regB = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Owner B',
          email: OWNER_B_EMAIL,
          password: PASSWORD,
          organizationName: 'Org B 16B1',
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

      // ---- Admin/Seller de A (membres actifs directs, hors register) ----
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

  describe('Autorisation — owner uniquement', () => {
    it('admin et seller reçoivent 403 OWNER_ONLY sur les 3 routes', async () => {
      for (const token of [adminAToken, sellerAToken]) {
        const created = await invite(token, {
          email: `refused-${Date.now()}@royalvibe.test`,
          role: 'admin',
        });
        expect(created.status).toBe(403);
        expect(created.body.code).toBe('OWNER_ONLY');

        const listed = await list(token);
        expect(listed.status).toBe(403);
        expect(listed.body.code).toBe('OWNER_ONLY');

        const revoked = await revoke(token, new Types.ObjectId().toString());
        expect(revoked.status).toBe(403);
        expect(revoked.body.code).toBe('OWNER_ONLY');
      }
    });

    it('sans JWT → 401 (jamais 403)', async () => {
      const res = await request(app.getHttpServer())
        .post('/organizations/invitations')
        .send({ email: 'x@royalvibe.test', role: 'admin' });
      expect(res.status).toBe(401);
    });
  });

  describe('Émission (POST) — cycle du token', () => {
    it('owner : 201, réponse exacte { invitation, token }, hash SHA-256 exact en base, jamais le clair', async () => {
      const email = `invite-ok-${Date.now()}@royalvibe.test`;
      const res = await invite(ownerAToken, { email, role: 'admin' });
      expect(res.status).toBe(201);

      const body = res.body as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['invitation', 'token']);
      expect(Object.keys(body.invitation as object).sort()).toEqual([
        '_id',
        'email',
        'expiresAt',
        'permissions',
        'role',
        'status',
      ]);
      expect(res.body.invitation.email).toBe(email);
      expect(res.body.invitation.status).toBe('pending');
      expect(JSON.stringify(res.body)).not.toContain('tokenHash');

      // Le hash en base (select:false) correspond exactement au token brut.
      const stored = await invitationModel
        .findOne({ _id: new Types.ObjectId(res.body.invitation._id as string) })
        .select('+tokenHash')
        .exec();
      expect(stored).toBeTruthy();
      expect(stored!.tokenHash).not.toBe(res.body.token);
      expect(stored!.tokenHash).toBe(
        createHash('sha256')
          .update(res.body.token as string)
          .digest('hex'),
      );
    });

    it('champs interdits (organizationId/role owner/permission inconnue) → 400 avant toute écriture', async () => {
      const before = await invitationModel.countDocuments();
      const rejections = await Promise.all([
        invite(ownerAToken, {
          email: 'forbidden-1@royalvibe.test',
          role: 'admin',
          organizationId: orgBId,
        }),
        invite(ownerAToken, {
          email: 'forbidden-2@royalvibe.test',
          role: 'owner',
        }),
        invite(ownerAToken, {
          email: 'forbidden-3@royalvibe.test',
          role: 'admin',
          permissions: ['ownership.transfer'],
        }),
        invite(ownerAToken, {
          email: 'forbidden-4@royalvibe.test',
          role: 'admin',
          permissions: ['sales.record', 'sales.record'],
        }),
      ]);
      for (const res of rejections) expect(res.status).toBe(400);
      expect(await invitationModel.countDocuments()).toBe(before);
    });

    it('membre actif existant dans cette org → 409 stable', async () => {
      const res = await invite(ownerAToken, {
        email: ADMIN_A_EMAIL,
        role: 'admin',
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MEMBER_ALREADY_ACTIVE');
    });

    it('seconde invitation pending pour le même email → 409, puis expiration → réinvitation acceptée', async () => {
      const email = `dup-pending-${Date.now()}@royalvibe.test`;
      const first = await invite(ownerAToken, { email, role: 'seller' });
      expect(first.status).toBe(201);

      const dup = await invite(ownerAToken, { email, role: 'admin' });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('INVITATION_ALREADY_PENDING');

      // Simule l'expiration (horloge testable au niveau service — ici on
      // vieillit directement le document, sans sleep réel).
      await invitationModel.updateOne(
        { _id: new Types.ObjectId(first.body.invitation._id as string) },
        { expiresAt: new Date(Date.now() - 1000) },
      );

      const reinvite = await invite(ownerAToken, { email, role: 'admin' });
      expect(reinvite.status).toBe(201);
      expect(reinvite.body.invitation.role).toBe('admin');

      const original = await invitationModel
        .findById(first.body.invitation._id as string)
        .exec();
      expect(original!.status).toBe('expired');
    });

    it("falsification organizationId (body/header/query) sans effet : l'org reste celle du JWT", async () => {
      const email = `forged-${Date.now()}@royalvibe.test`;
      const res = await request(app.getHttpServer())
        .post('/organizations/invitations?organizationId=' + orgBId)
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('x-organization-id', orgBId)
        .send({ email, role: 'admin' });
      expect(res.status).toBe(201);

      const stored = await invitationModel.findOne({ email }).exec();
      expect(stored!.organizationId.toString()).toBe(orgAId);
      expect(stored!.organizationId.toString()).not.toBe(orgBId);
    });
  });

  describe('Isolation A/B — liste et révocation', () => {
    it('owner A ne voit JAMAIS les invitations de B, et réciproquement', async () => {
      const emailA = `isoa-${Date.now()}@royalvibe.test`;
      const emailB = `isob-${Date.now()}@royalvibe.test`;
      const createdA = await invite(ownerAToken, {
        email: emailA,
        role: 'admin',
      });
      const createdB = await invite(ownerBToken, {
        email: emailB,
        role: 'admin',
      });
      expect(createdA.status).toBe(201);
      expect(createdB.status).toBe(201);

      const listA = await list(ownerAToken);
      expect(listA.status).toBe(200);
      expect(
        (listA.body as Array<{ email: string }>).some(
          (i) => i.email === emailB,
        ),
      ).toBe(false);
      expect(
        (listA.body as Array<{ email: string }>).some(
          (i) => i.email === emailA,
        ),
      ).toBe(true);
      expect(JSON.stringify(listA.body)).not.toContain('token');

      const listB = await list(ownerBToken);
      expect(
        (listB.body as Array<{ email: string }>).some(
          (i) => i.email === emailA,
        ),
      ).toBe(false);
    });

    it('owner A ne peut jamais révoquer une invitation de B → 404 (même 404 que absente)', async () => {
      const emailB = `revoke-b-${Date.now()}@royalvibe.test`;
      const created = await invite(ownerBToken, {
        email: emailB,
        role: 'admin',
      });
      const bId = created.body.invitation._id as string;

      const foreign = await revoke(ownerAToken, bId);
      const missing = await revoke(
        ownerAToken,
        new Types.ObjectId().toString(),
      );
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(foreign.status).toBe(missing.status);

      // Intacte côté B (jamais révoquée par A) :
      const stillPending = await invitationModel.findById(bId).exec();
      expect(stillPending!.status).toBe('pending');
    });

    it('owner A révoque sa propre invitation → 200, vue sans token, statut `revoked` en base', async () => {
      const email = `revoke-ok-${Date.now()}@royalvibe.test`;
      const created = await invite(ownerAToken, { email, role: 'seller' });
      const id = created.body.invitation._id as string;

      const res = await revoke(ownerAToken, id);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('revoked');
      expect(JSON.stringify(res.body)).not.toContain('token');

      const stored = await invitationModel.findById(id).exec();
      expect(stored!.status).toBe('revoked');

      // Une invitation déjà révoquée ne peut plus être révoquée deux fois :
      const second = await revoke(ownerAToken, id);
      expect(second.status).toBe(404);
    });
  });
});
