import 'reflect-metadata';
import { createHash } from 'crypto';
import { Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { AUTH_RATE_LIMIT_CODE } from './../src/common/auth-rate-limiting';
import { UserDocument } from './../src/users/schemas/user.schema';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
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
  let organizationModel: Model<OrganizationDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let invitationModel: Model<OrganizationInvitationDocument>;
  let jwtService: JwtService;

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
      organizationModel = moduleFixture.get(getModelToken(Organization.name));
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );
      invitationModel = moduleFixture.get(
        getModelToken(OrganizationInvitation.name),
      );
      jwtService = moduleFixture.get(JwtService);

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

  describe('Acceptation (POST /auth/invitations/accept) — 1-6B.2', () => {
    const clearThrottle = (): void => {
      moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
    };
    beforeEach(clearThrottle);

    const accept = (body: Record<string, unknown>) =>
      request(app.getHttpServer()).post('/auth/invitations/accept').send(body);

    it('publique même si PUBLIC_REGISTRATION_ENABLED=false (jamais bloquée par ce flag)', async () => {
      delete process.env.PUBLIC_REGISTRATION_ENABLED;
      const res = await accept({ token: 'unknown-token' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVITATION_INVALID_OR_EXPIRED');
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
    });

    it('token inconnu → 400 générique, zéro écriture', async () => {
      const usersBefore = await userModel.countDocuments();
      const res = await accept({ token: 'totally-unknown-token' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVITATION_INVALID_OR_EXPIRED');
      expect(await userModel.countDocuments()).toBe(usersBefore);
    });

    it('nouveau user : triplet atomique, password haché, rôle legacy `seller` (jamais admin), rôle/permissions/invitedBy copiés, réponse sans donnée sensible', async () => {
      const email = `accept-new-${Date.now()}@royalvibe.test`;
      const issued = await invite(ownerAToken, {
        email,
        role: 'admin',
        permissions: ['analytics.read'],
      });
      expect(issued.status).toBe(201);

      const res = await accept({
        token: issued.body.token as string,
        name: 'New User',
        password: 'accept-pw-!1x',
      });
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([
        'membership',
        'organization',
        'user',
      ]);
      expect(res.body.user.email).toBe(email);
      expect(res.body.organization._id).toBe(orgAId);
      expect(res.body.membership.role).toBe('admin');
      expect(res.body.membership.status).toBe('active');
      const flat = JSON.stringify(res.body);
      expect(flat).not.toContain('password');
      expect(flat).not.toContain('access_token');
      expect(flat).not.toContain('tokenHash');
      expect(flat).not.toContain('permissions'); // membership ne renvoie que role+status

      // Rôle LEGACY `User.role` : seller — jamais promu même pour un invite `admin`.
      const userDoc = await userModel
        .findOne({ email })
        .select('+password')
        .exec();
      expect(userDoc!.role).toBe('seller');
      expect(userDoc!.password).not.toBe('accept-pw-!1x');
      await expect(
        bcrypt.compare('accept-pw-!1x', userDoc!.password),
      ).resolves.toBe(true);

      // role/permissions/invitedById EXACTEMENT copiés de l'invitation :
      const membership = await membershipModel
        .findOne({
          organizationId: new Types.ObjectId(orgAId),
          userId: userDoc!._id,
        })
        .exec();
      expect(membership!.role).toBe('admin');
      expect(membership!.permissions).toEqual(['analytics.read']);
      const ownerADoc = await userModel
        .findOne({ email: OWNER_A_EMAIL })
        .exec();
      expect(membership!.invitedById!.toString()).toBe(
        ownerADoc!._id.toString(),
      );

      const invitationDoc = await invitationModel
        .findById(issued.body.invitation._id as string)
        .exec();
      expect(invitationDoc!.status).toBe('accepted');
      expect(invitationDoc!.acceptedAt).toBeTruthy();
    });

    it('user existant : aucune modification du User (password/name/role intacts)', async () => {
      const before = await userModel
        .findOne({ email: SELLER_A_EMAIL })
        .select('+password')
        .exec();
      // sellerA n'a AUCUNE membership dans B : l'émission y est acceptée.
      const issued = await invite(ownerBToken, {
        email: SELLER_A_EMAIL,
        role: 'seller',
      });
      expect(issued.status).toBe(201);

      const res = await accept({ token: issued.body.token as string });
      expect(res.status).toBe(200);
      expect(res.body.user.name).toBe(before!.name);
      expect(res.body.organization._id).toBe(orgBId);

      const after = await userModel
        .findOne({ email: SELLER_A_EMAIL })
        .select('+password')
        .exec();
      expect(after!.password).toBe(before!.password);
      expect(after!.name).toBe(before!.name);
      expect(after!.role).toBe(before!.role);

      const membership = await membershipModel
        .findOne({
          organizationId: new Types.ObjectId(orgBId),
          userId: after!._id,
        })
        .exec();
      expect(membership).toBeTruthy();
      expect(membership!.role).toBe('seller');
    });

    it('token expiré/révoqué/déjà accepté → même 400, zéro écriture', async () => {
      // expiré :
      const emailExp = `accept-exp-${Date.now()}@royalvibe.test`;
      const issuedExp = await invite(ownerAToken, {
        email: emailExp,
        role: 'seller',
      });
      await invitationModel.updateOne(
        { _id: new Types.ObjectId(issuedExp.body.invitation._id as string) },
        { expiresAt: new Date(Date.now() - 1000) },
      );
      const usersBefore = await userModel.countDocuments();
      const resExp = await accept({
        token: issuedExp.body.token as string,
        name: 'X',
        password: 'accept-pw-!1x',
      });
      expect(resExp.status).toBe(400);
      expect(resExp.body.code).toBe('INVITATION_INVALID_OR_EXPIRED');
      expect(await userModel.countDocuments()).toBe(usersBefore);

      // révoqué :
      const emailRev = `accept-rev-${Date.now()}@royalvibe.test`;
      const issuedRev = await invite(ownerAToken, {
        email: emailRev,
        role: 'seller',
      });
      await revoke(ownerAToken, issuedRev.body.invitation._id as string);
      const resRev = await accept({
        token: issuedRev.body.token as string,
        name: 'X',
        password: 'accept-pw-!1x',
      });
      expect(resRev.status).toBe(400);
      expect(resRev.body.code).toBe('INVITATION_INVALID_OR_EXPIRED');

      // déjà accepté (réutilisation du même token) :
      const emailAcc = `accept-acc-${Date.now()}@royalvibe.test`;
      const issuedAcc = await invite(ownerAToken, {
        email: emailAcc,
        role: 'seller',
      });
      const firstAccept = await accept({
        token: issuedAcc.body.token as string,
        name: 'Y',
        password: 'accept-pw-!1x',
      });
      expect(firstAccept.status).toBe(200);
      const secondAccept = await accept({
        token: issuedAcc.body.token as string,
        name: 'Y2',
        password: 'accept-pw-!1x',
      });
      expect(secondAccept.status).toBe(400);
      expect(secondAccept.body.code).toBe('INVITATION_INVALID_OR_EXPIRED');
    });

    it('organisation suspendue → même 400 générique', async () => {
      const email = `accept-susp-${Date.now()}@royalvibe.test`;
      const issued = await invite(ownerAToken, { email, role: 'seller' });
      await organizationModel.updateOne(
        { _id: new Types.ObjectId(orgAId) },
        { status: 'suspended' },
      );
      try {
        const res = await accept({
          token: issued.body.token as string,
          name: 'Z',
          password: 'accept-pw-!1x',
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVITATION_INVALID_OR_EXPIRED');
      } finally {
        await organizationModel.updateOne(
          { _id: new Types.ObjectId(orgAId) },
          { status: 'active' },
        );
      }
    });

    it('membership déjà existante (même révoquée) → 409, AUCUNE réactivation silencieuse', async () => {
      const email = `accept-conflict-${Date.now()}@royalvibe.test`;
      const revokedUser = await userModel.create({
        name: 'Revoked',
        email,
        password: await bcrypt.hash(PASSWORD, 10),
      });
      await membershipModel.create({
        organizationId: new Types.ObjectId(orgAId),
        userId: revokedUser._id,
        role: 'seller',
        status: 'revoked',
      });

      // Émission acceptée : le pré-check d'émission n'exclut QUE les membres ACTIFS.
      const issued = await invite(ownerAToken, { email, role: 'admin' });
      expect(issued.status).toBe(201);

      const res = await accept({ token: issued.body.token as string });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MEMBERSHIP_ALREADY_EXISTS');

      const membership = await membershipModel
        .findOne({
          organizationId: new Types.ObjectId(orgAId),
          userId: revokedUser._id,
        })
        .exec();
      expect(membership!.status).toBe('revoked');
    });

    it('rollback après création User + Membership (garde finale) → aucune trace', async () => {
      const email = `accept-rollback-${Date.now()}@royalvibe.test`;
      const issued = await invite(ownerAToken, { email, role: 'seller' });
      const membershipsBefore = await membershipModel.countDocuments({
        organizationId: new Types.ObjectId(orgAId),
      });

      const originalCount = membershipModel.countDocuments.bind(
        membershipModel,
      ) as (filter?: unknown, opts?: { session?: unknown }) => Promise<number>;
      membershipModel.countDocuments = ((
        filter?: unknown,
        opts?: { session?: unknown },
      ) => {
        if (opts?.session) {
          return Promise.resolve(2); // force l'invariant à échouer
        }
        return originalCount(filter, opts);
      }) as unknown as typeof membershipModel.countDocuments;

      let res: request.Response;
      try {
        res = await accept({
          token: issued.body.token as string,
          name: 'Rollback',
          password: 'accept-pw-!1x',
        });
      } finally {
        membershipModel.countDocuments =
          originalCount as unknown as typeof membershipModel.countDocuments;
      }
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await userModel.countDocuments({ email })).toBe(0);
      expect(
        await membershipModel.countDocuments({
          organizationId: new Types.ObjectId(orgAId),
        }),
      ).toBe(membershipsBefore);
    });

    it('acceptation concurrente (même token) : exactement une réussite, aucune duplication', async () => {
      const email = `accept-race-${Date.now()}@royalvibe.test`;
      const issued = await invite(ownerAToken, { email, role: 'seller' });
      const body = {
        token: issued.body.token as string,
        name: 'Race',
        password: 'accept-pw-!1x',
      };
      const [a, b] = await Promise.all([accept(body), accept(body)]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 400]);
      expect(await userModel.countDocuments({ email })).toBe(1);
      const user = await userModel.findOne({ email }).exec();
      expect(
        await membershipModel.countDocuments({
          organizationId: new Types.ObjectId(orgAId),
          userId: user!._id,
        }),
      ).toBe(1);
    }, 20_000);

    it('émission concurrente (même org+email) → 201/409, jamais 500', async () => {
      const email = `issue-race-${Date.now()}@royalvibe.test`;
      const [a, b] = await Promise.all([
        invite(ownerAToken, { email, role: 'seller' }),
        invite(ownerAToken, { email, role: 'admin' }),
      ]);
      const statuses = [a.status, b.status].sort((x, y) => x - y);
      expect(statuses).toEqual([201, 409]);
      const conflict = a.status === 409 ? a : b;
      expect(conflict.body.code).toBe('INVITATION_ALREADY_PENDING');
      expect(
        await invitationModel.countDocuments({ email, status: 'pending' }),
      ).toBe(1);
    }, 20_000);

    it('login après acceptation retourne un JWT avec le bon orgId', async () => {
      const email = `accept-login-${Date.now()}@royalvibe.test`;
      const password = 'accept-pw-!1x';
      const issued = await invite(ownerAToken, { email, role: 'seller' });
      const acc = await accept({
        token: issued.body.token as string,
        name: 'Login Test',
        password,
      });
      expect(acc.status).toBe(200);

      const loginRes = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password });
      expect(loginRes.status).toBe(201);
      const payload = jwtService.decode(String(loginRes.body.access_token));
      expect(String(payload.orgId)).toBe(orgAId);
    });

    it('champs interdits (role/organizationId/permissions/invitedById) → 400 avant toute écriture', async () => {
      const email = `accept-forbidden-${Date.now()}@royalvibe.test`;
      const issued = await invite(ownerAToken, { email, role: 'seller' });
      const usersBefore = await userModel.countDocuments();
      const res = await accept({
        token: issued.body.token as string,
        name: 'F',
        password: 'accept-pw-!1x',
        role: 'owner',
      });
      expect(res.status).toBe(400);
      expect(await userModel.countDocuments()).toBe(usersBefore);
    });

    it('rate limiting existant (429) s’applique aussi à /auth/invitations/accept', async () => {
      let last: request.Response | undefined;
      for (let i = 0; i < 11; i++) {
        last = await accept({ token: `rl-${i}-${Date.now()}` });
      }
      expect(last!.status).toBe(429);
      expect(last!.body.code).toBe(AUTH_RATE_LIMIT_CODE);
    });
  });
});
