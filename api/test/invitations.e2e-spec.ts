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
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import {
  E2E_EMAIL_VERIFIED_AT,
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';
import { INVITATION_TERMS, OWNER_TERMS } from './e2e/legal-acceptance-fixtures';
import {
  accountTokenFrom,
  createInvitedAccount,
  requestAccountToken,
  waitFor,
} from './e2e/invitation-acceptance-fixtures';
import { postRegister } from './e2e/registration-fixtures';

// 1-13A : expéditeur simulé, liens confirmés via le service réel.
const emailSender = createE2eEmailSender();

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
// 1-12G : origine publique des liens d'invitation (jamais l'en-tête Host).
const E2E_PUBLIC_APP_URL = 'https://app.invitations-e2e.test';

/** Token brut extrait du lien renvoyé à la création (1-12G). */
function tokenOf(res: { body: { invitationUrl?: unknown } }): string {
  return (
    new URL(String(res.body.invitationUrl)).searchParams.get('token') ?? ''
  );
}

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

  // Correction sécurité 1-10B : `POST /organizations/invitations` porte
  // désormais une fenêtre `invitation-create` (5/60 s, tracker user+org)
  // partageant le MÊME stockage mémoire que le rate limiting existant
  // (0B.6). Réinitialisé avant CHAQUE test de ce fichier — sans cela, les
  // nombreux appels `invite()` réutilisant les mêmes acteurs/organisations
  // d'un test à l'autre épuiseraient ce quota (le comportement de limite
  // lui-même est testé isolément dans invitation-rate-limiting.e2e-spec.ts).
  beforeEach(() => {
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
  });

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
      process.env.PUBLIC_APP_URL = E2E_PUBLIC_APP_URL;
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
      invitationModel = moduleFixture.get(
        getModelToken(OrganizationInvitation.name),
      );
      jwtService = moduleFixture.get(JwtService);

      // ---- Owner A + Owner B : onboarding atomique réel (1-6A) ----
      const regA = await postRegister(app, {
        ...OWNER_TERMS,
        name: 'Owner A',
        email: OWNER_A_EMAIL,
        password: PASSWORD,
        organizationName: 'Org A 16B1',
      });
      expect(regA.status).toBe(202);
      orgAId = regA.owner!.organization._id;

      const regB = await postRegister(app, {
        ...OWNER_TERMS,
        name: 'Owner B',
        email: OWNER_B_EMAIL,
        password: PASSWORD,
        organizationName: 'Org B 16B1',
      });
      expect(regB.status).toBe(202);
      orgBId = regB.owner!.organization._id;

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

  describe('Autorisation — members.invite (1-7B, ex owner-only)', () => {
    it('admin (permission par défaut) : 201/200 sur les 3 routes', async () => {
      const created = await invite(adminAToken, {
        email: `admin-delegate-${Date.now()}@royalvibe.test`,
        role: 'seller',
      });
      expect(created.status).toBe(201);

      const listed = await list(adminAToken);
      expect(listed.status).toBe(200);

      const revoked = await revoke(
        adminAToken,
        created.body.invitation._id as string,
      );
      expect(revoked.status).toBe(200);
    });

    it('seller sans délégation → 403 PERMISSION_DENIED sur les 3 routes, service jamais muté', async () => {
      const before = await invitationModel.countDocuments();
      for (const res of [
        await invite(sellerAToken, {
          email: `refused-${Date.now()}@royalvibe.test`,
          role: 'admin',
        }),
        await list(sellerAToken),
        await revoke(sellerAToken, new Types.ObjectId().toString()),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('PERMISSION_DENIED');
      }
      expect(await invitationModel.countDocuments()).toBe(before);
    });

    it('seller DÉLÉGUÉ members.invite (membership.permissions) → 201/200 sur les 3 routes', async () => {
      const delegatedEmail = `delegated-seller-17b-${Date.now()}@royalvibe.test`;
      const delegated = await userModel.create({
        emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
        name: 'Delegated Seller',
        email: delegatedEmail,
        password: await bcrypt.hash(PASSWORD, 10),
      });
      await membershipModel.create({
        organizationId: new Types.ObjectId(orgAId),
        userId: delegated._id,
        role: 'seller',
        status: 'active',
        permissions: ['members.invite'],
      });
      const loginDelegated = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: delegatedEmail,
          password: PASSWORD,
          organizationId: orgAId,
        });
      expect(loginDelegated.status).toBe(201);
      const delegatedToken = loginDelegated.body.access_token as string;

      const created = await invite(delegatedToken, {
        email: `delegated-invite-${Date.now()}@royalvibe.test`,
        role: 'seller',
      });
      expect(created.status).toBe(201);
      const listed = await list(delegatedToken);
      expect(listed.status).toBe(200);
      const revoked = await revoke(
        delegatedToken,
        created.body.invitation._id as string,
      );
      expect(revoked.status).toBe(200);
    });

    it('sans JWT → 401 (jamais 403)', async () => {
      const res = await request(app.getHttpServer())
        .post('/organizations/invitations')
        .send({ email: 'x@royalvibe.test', role: 'admin' });
      expect(res.status).toBe(401);
    });
  });

  describe('Émission (POST) — cycle du token', () => {
    it('owner : 201, réponse exacte { invitation, invitationUrl }, lien PUBLIC_APP_URL, hash SHA-256 exact en base, jamais le clair', async () => {
      const email = `invite-ok-${Date.now()}@royalvibe.test`;
      const res = await invite(ownerAToken, { email, role: 'admin' });
      expect(res.status).toBe(201);

      const body = res.body as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['invitation', 'invitationUrl']);
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
      // 1-12G : lien construit depuis PUBLIC_APP_URL, jamais depuis Host.
      const token = tokenOf(res);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(res.body.invitationUrl).toBe(
        `${E2E_PUBLIC_APP_URL}/auth/invitations/accept?token=${encodeURIComponent(token)}`,
      );
      expect(JSON.stringify(res.body)).not.toContain('tokenHash');

      // Le hash en base (select:false) correspond exactement au token brut.
      const stored = await invitationModel
        .findOne({ _id: new Types.ObjectId(res.body.invitation._id as string) })
        .select('+tokenHash')
        .exec();
      expect(stored).toBeTruthy();
      expect(stored!.tokenHash).not.toBe(token);
      expect(stored!.tokenHash).toBe(
        createHash('sha256').update(token).digest('hex'),
      );
      // Token brut jamais persisté ni relisible : ni en base, ni en liste.
      expect(JSON.stringify(stored!.toObject())).not.toContain(token);
      const listed = await request(app.getHttpServer())
        .get('/organizations/invitations')
        .set('Authorization', `Bearer ${ownerAToken}`);
      expect(listed.status).toBe(200);
      expect(JSON.stringify(listed.body)).not.toContain(token);
      expect(JSON.stringify(listed.body)).not.toContain('invitationUrl');
    });

    it('en-tête Host forgé : le lien garde l’origine PUBLIC_APP_URL', async () => {
      const res = await request(app.getHttpServer())
        .post('/organizations/invitations')
        .set('Authorization', `Bearer ${ownerAToken}`)
        .set('Host', 'evil.example.com')
        .set('X-Forwarded-Host', 'evil.example.com')
        .send({
          email: `invite-host-${Date.now()}@royalvibe.test`,
          role: 'seller',
        });
      expect(res.status).toBe(201);
      expect(new URL(res.body.invitationUrl as string).origin).toBe(
        E2E_PUBLIC_APP_URL,
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

    it('owner A révoque sa propre invitation → 200, vue sans token, invitation supprimée (1-19A)', async () => {
      const email = `revoke-ok-${Date.now()}@royalvibe.test`;
      const created = await invite(ownerAToken, { email, role: 'seller' });
      const id = created.body.invitation._id as string;

      const res = await revoke(ownerAToken, id);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('revoked');
      expect(JSON.stringify(res.body)).not.toContain('token');

      const stored = await invitationModel.findById(id).exec();
      expect(stored).toBeNull();

      // Une invitation déjà révoquée ne peut plus être révoquée deux fois :
      const second = await revoke(ownerAToken, id);
      expect(second.status).toBe(404);
    });
  });

  // CORRECTION SÉCURITÉ (1-9C) : `PermissionGuard` ne vérifie que la
  // permission `members.invite` de l'acteur, jamais que le rôle/permissions
  // DE L'INVITATION restent dans ses droits effectifs. Ces requêtes sont
  // envoyées directement via `supertest` — un client HTTP brut, AUCUN
  // frontend en jeu — la preuve que l'API refuse l'escalade indépendamment
  // de tout filtrage côté client.
  describe('Anti-escalade des invitations (1-9C) — requêtes API forgées, frontend non-autorité', () => {
    const escalationEmail = (label: string) =>
      `escalation-${label}-${Date.now()}@royalvibe.test`;

    it('seller délégué members.invite SEUL tente role=admin (requête forgée) → 403 PERMISSION_DENIED, zéro écriture', async () => {
      const email = escalationEmail('admin-role');
      const inviteOnlyEmail = `invite-only-a-${Date.now()}@royalvibe.test`;
      const inviteOnly = await userModel.create({
        emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
        name: 'Invite Only Seller',
        email: inviteOnlyEmail,
        password: await bcrypt.hash(PASSWORD, 10),
      });
      await membershipModel.create({
        organizationId: new Types.ObjectId(orgAId),
        userId: inviteOnly._id,
        role: 'seller',
        status: 'active',
        permissions: ['members.invite'],
      });
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: inviteOnlyEmail,
          password: PASSWORD,
          organizationId: orgAId,
        });
      expect(login.status).toBe(201);
      const inviteOnlyToken = login.body.access_token as string;

      const before = await invitationModel.countDocuments();
      // Requête forgée : un client HTTP brut peut envoyer n'importe quel
      // `role`/`permissions` autorisé par le DTO — la validation de forme
      // (whitelist) laisse passer `role: 'admin'`, seule l'autorisation
      // métier doit le refuser.
      const res = await invite(inviteOnlyToken, { email, role: 'admin' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
      expect(await invitationModel.countDocuments()).toBe(before);
      expect(await invitationModel.findOne({ email }).exec()).toBeNull();
    });

    it('seller délégué members.invite SEUL tente de greffer une permission qu’il ne possède pas → 403, zéro écriture', async () => {
      const email = escalationEmail('extra-perm');
      const inviteOnlyEmail = `invite-only-b-${Date.now()}@royalvibe.test`;
      const inviteOnly = await userModel.create({
        emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
        name: 'Invite Only Seller 2',
        email: inviteOnlyEmail,
        password: await bcrypt.hash(PASSWORD, 10),
      });
      await membershipModel.create({
        organizationId: new Types.ObjectId(orgAId),
        userId: inviteOnly._id,
        role: 'seller',
        status: 'active',
        permissions: ['members.invite'],
      });
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: inviteOnlyEmail,
          password: PASSWORD,
          organizationId: orgAId,
        });
      expect(login.status).toBe(201);
      const inviteOnlyToken = login.body.access_token as string;

      const before = await invitationModel.countDocuments();
      const res = await invite(inviteOnlyToken, {
        email,
        role: 'seller',
        permissions: ['members.manage'],
      });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
      expect(await invitationModel.countDocuments()).toBe(before);
    });

    it('seller invite un seller avec un sous-ensemble strictement autorisé de ses propres permissions → 201', async () => {
      const email = escalationEmail('allowed-subset');
      const delegatedEmail = `invite-analytics-${Date.now()}@royalvibe.test`;
      const delegated = await userModel.create({
        emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
        name: 'Invite Analytics',
        email: delegatedEmail,
        password: await bcrypt.hash(PASSWORD, 10),
      });
      await membershipModel.create({
        organizationId: new Types.ObjectId(orgAId),
        userId: delegated._id,
        role: 'seller',
        status: 'active',
        permissions: ['members.invite', 'analytics.read'],
      });
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: delegatedEmail,
          password: PASSWORD,
          organizationId: orgAId,
        });
      expect(login.status).toBe(201);
      const delegatedToken = login.body.access_token as string;

      const res = await invite(delegatedToken, {
        email,
        role: 'seller',
        permissions: ['analytics.read'],
      });

      expect(res.status).toBe(201);
      expect(res.body.invitation.permissions).toEqual(['analytics.read']);
    });

    it('isolation : admin de l’organisation B, seulement seller+members.invite dans A, ne peut PAS exploiter son rôle B depuis A', async () => {
      const email = escalationEmail('cross-org');
      const crossEmail = `cross-org-admin-${Date.now()}@royalvibe.test`;
      const crossUser = await userModel.create({
        emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
        name: 'Cross Org User',
        email: crossEmail,
        password: await bcrypt.hash(PASSWORD, 10),
      });
      // Admin ACTIF réel dans B (permissions par défaut = tout le délégable) :
      await membershipModel.create({
        organizationId: new Types.ObjectId(orgBId),
        userId: crossUser._id,
        role: 'admin',
        status: 'active',
      });
      // Seulement `members.invite` dans A — jamais admin ici :
      await membershipModel.create({
        organizationId: new Types.ObjectId(orgAId),
        userId: crossUser._id,
        role: 'seller',
        status: 'active',
        permissions: ['members.invite'],
      });
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: crossEmail,
          password: PASSWORD,
          organizationId: orgAId,
        });
      expect(login.status).toBe(201);
      const crossToken = login.body.access_token as string;

      const before = await invitationModel.countDocuments();
      // Contexte HTTP = organisation A (JWT) : la relecture serveur de
      // l'acteur doit filtrer par (organizationId=A, userId) — jamais par
      // userId seul, sinon la membership `admin` de B fuiterait ici.
      const res = await invite(crossToken, { email, role: 'admin' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
      expect(await invitationModel.countDocuments()).toBe(before);
    });

    it('owner A conserve la capacité normale d’inviter admin (contrôle positif, non régressé)', async () => {
      const email = escalationEmail('owner-control');
      const res = await invite(ownerAToken, { email, role: 'admin' });
      expect(res.status).toBe(201);
      expect(res.body.invitation.role).toBe('admin');
    });
  });

  // ===========================================================================
  // 1-18B — Acceptation : le lien remis au créateur ne prouve ni l'identité
  // de son détenteur ni le contrôle de l'adresse invitée.
  // ===========================================================================
  describe('Acceptation (1-18B) — session du compte invité ou lien reçu à l’adresse invitée', () => {
    const clearThrottle = (): void => {
      moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
    };
    beforeEach(() => {
      clearThrottle();
      emailSender.reset();
    });

    const server = () => app.getHttpServer();
    const inspect = (jwt: string | null, body: Record<string, unknown>) => {
      const req = request(server()).post('/auth/invitations/inspect');
      if (jwt) req.set('Authorization', `Bearer ${jwt}`);
      return req.send(body);
    };
    const accept = (jwt: string | null, body: Record<string, unknown>) => {
      const req = request(server()).post('/auth/invitations/accept');
      if (jwt) req.set('Authorization', `Bearer ${jwt}`);
      return req.send(body);
    };
    const accountLink = (token: string) =>
      request(server()).post('/auth/invitations/account-link').send({ token });
    const createAccount = (body: Record<string, unknown>) =>
      request(server())
        .post('/auth/invitations/create-account')
        .send({ ...INVITATION_TERMS, ...body });
    const login = (email: string, organizationId?: string) =>
      request(server())
        .post('/auth/login')
        .send({ email, password: PASSWORD, organizationId });

    let seq = 0;
    /** Compte vérifié existant, membre actif de A seulement, et sa session. */
    async function existingAccount(label: string) {
      seq += 1;
      const email = `${label}-${seq}-${Date.now()}@royalvibe.test`;
      const user = await userModel.create({
        emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
        name: `Nom secret ${seq}`,
        email,
        password: await bcrypt.hash(PASSWORD, 10),
      });
      await membershipModel.create({
        organizationId: new Types.ObjectId(orgAId),
        userId: user._id,
        role: 'seller',
        status: 'active',
      });
      const res = await login(email, orgAId);
      expect(res.status).toBe(201);
      return {
        email,
        name: user.name,
        id: user._id,
        jwt: res.body.access_token as string,
      };
    }

    /** Invitation émise par owner B (organisation dont le compte n'est pas membre). */
    async function inviteToB(
      email: string,
      body: Record<string, unknown> = {},
    ) {
      const issued = await invite(ownerBToken, {
        email,
        role: 'seller',
        ...body,
      });
      expect(issued.status).toBe(201);
      return {
        token: tokenOf(issued),
        id: issued.body.invitation._id as string,
      };
    }

    // 1-19A : une invitation acceptée est SUPPRIMÉE (`deleted`).
    const invitationStatus = async (id: string) =>
      (await invitationModel.findById(id).exec())?.status ?? 'deleted';
    const membershipsInB = (userId: Types.ObjectId) =>
      membershipModel.countDocuments({
        organizationId: new Types.ObjectId(orgBId),
        userId,
      });

    describe('compte existant : session et accord explicite', () => {
      it('sans session : 401 pour toute variante du corps, réponses identiques, invitation intacte, aucun nom', async () => {
        const target = await existingAccount('no-session');
        const invitation = await inviteToB(target.email);
        const variants: Record<string, unknown>[] = [
          { token: invitation.token },
          { token: invitation.token, consent: true },
          { token: invitation.token, name: 'X', password: 'secret-123' },
          { token: invitation.token, email: target.email },
          { token: 'unknown-token', consent: true },
          {},
        ];
        const bodies = new Set<string>();
        for (const body of variants) {
          for (const route of [accept, inspect]) {
            const res = await route(null, body);
            expect(res.status).toBe(401);
            const { timestamp, path, ...stable } = res.body as Record<
              string,
              unknown
            >;
            void timestamp;
            void path;
            bodies.add(JSON.stringify(stable));
            expect(JSON.stringify(res.body)).not.toContain(target.name);
            expect(JSON.stringify(res.body)).not.toContain(target.email);
          }
        }
        expect(bodies.size).toBe(1);
        expect(await invitationStatus(invitation.id)).toBe('pending');
        expect(await membershipsInB(target.id)).toBe(0);
      });

      it('créateur qui tente d’accepter pour un tiers avec SA session : 403 mauvais compte, rien consommé, aucun nom', async () => {
        const target = await existingAccount('creator-third');
        const invitation = await inviteToB(target.email);

        const preview = await inspect(ownerBToken, { token: invitation.token });
        expect(preview.status).toBe(403);
        expect(preview.body.code).toBe('INVITATION_ACCOUNT_MISMATCH');
        const res = await accept(ownerBToken, {
          token: invitation.token,
          consent: true,
        });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('INVITATION_ACCOUNT_MISMATCH');
        for (const body of [preview.body, res.body]) {
          expect(JSON.stringify(body)).not.toContain(target.name);
          expect(JSON.stringify(body)).not.toContain(target.email);
        }
        expect(await invitationStatus(invitation.id)).toBe('pending');
        expect(await membershipsInB(target.id)).toBe(0);
      });

      it('mauvais compte (autre utilisateur connecté) : 403, jamais de rattachement, l’invitation reste utilisable par le bon compte', async () => {
        const target = await existingAccount('right');
        const other = await existingAccount('wrong');
        const invitation = await inviteToB(target.email);

        const wrong = await accept(other.jwt, {
          token: invitation.token,
          consent: true,
        });
        expect(wrong.status).toBe(403);
        expect(wrong.body.code).toBe('INVITATION_ACCOUNT_MISMATCH');
        expect(await membershipsInB(other.id)).toBe(0);
        expect(await membershipsInB(target.id)).toBe(0);
        expect(await invitationStatus(invitation.id)).toBe('pending');

        const right = await accept(target.jwt, {
          token: invitation.token,
          consent: true,
        });
        expect(right.status).toBe(200);
      });

      it('session expirée ou révoquée : 401, invitation intacte', async () => {
        const target = await existingAccount('expired');
        const invitation = await inviteToB(target.email);
        const expired = jwtService.sign(
          { sub: target.id.toString(), orgId: orgAId },
          { expiresIn: -60 },
        );
        const res = await accept(expired, {
          token: invitation.token,
          consent: true,
        });
        expect(res.status).toBe(401);

        // Réinitialisation du mot de passe : version de session incrémentée.
        await userModel.updateOne(
          { _id: target.id },
          { $inc: { authVersion: 1 } },
        );
        const revoked = await accept(target.jwt, {
          token: invitation.token,
          consent: true,
        });
        expect(revoked.status).toBe(401);
        expect(await invitationStatus(invitation.id)).toBe('pending');
        expect(await membershipsInB(target.id)).toBe(0);
      });

      it('bon compte : aperçu sans écriture, accord obligatoire, puis rattachement exact (sans adhésion préalable à B), compte inchangé', async () => {
        const target = await existingAccount('consent');
        const before = await userModel
          .findById(target.id)
          .select('+password +authVersion')
          .lean()
          .exec();
        const invitation = await inviteToB(target.email, {
          permissions: ['analytics.read'],
        });

        const preview = await inspect(target.jwt, { token: invitation.token });
        expect(preview.status).toBe(200);
        expect(preview.body).toEqual({
          organization: { name: 'Org B 16B1' },
          role: 'seller',
        });
        expect(await invitationStatus(invitation.id)).toBe('pending');

        // Accord absent, faux ou mal typé : refus, rien consommé.
        for (const consent of [undefined, false, 'true']) {
          const refused = await accept(target.jwt, {
            token: invitation.token,
            ...(consent === undefined ? {} : { consent }),
          });
          expect(refused.status).toBe(400);
        }
        expect(await invitationStatus(invitation.id)).toBe('pending');
        expect(await membershipsInB(target.id)).toBe(0);

        const res = await accept(target.jwt, {
          token: invitation.token,
          consent: true,
        });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          organization: {
            _id: orgBId,
            name: 'Org B 16B1',
            slug: expect.any(String),
          },
          membership: { role: 'seller', status: 'active' },
        });
        const membership = await membershipModel
          .findOne({
            organizationId: new Types.ObjectId(orgBId),
            userId: target.id,
          })
          .exec();
        expect(membership!.permissions).toEqual(['analytics.read']);
        const ownerB = await userModel.findOne({ email: OWNER_B_EMAIL }).exec();
        expect(membership!.invitedById!.toString()).toBe(
          ownerB!._id.toString(),
        );

        const after = await userModel
          .findById(target.id)
          .select('+password +authVersion')
          .lean()
          .exec();
        expect(after).toEqual(before);
        expect(await invitationStatus(invitation.id)).toBe('deleted');

        // Usage unique ; connexion à B ensuite possible.
        const replay = await accept(target.jwt, {
          token: invitation.token,
          consent: true,
        });
        expect(replay.status).toBe(400);
        expect(replay.body.code).toBe('INVITATION_INVALID_OR_EXPIRED');
        const inB = await login(target.email, orgBId);
        expect(inB.status).toBe(201);
        const payload = jwtService.decode(String(inB.body.access_token));
        expect(String(payload.orgId)).toBe(orgBId);
      });

      it('expirée, révoquée, déjà utilisée, organisation suspendue → même 400, rien écrit', async () => {
        const target = await existingAccount('states');
        const expired = await inviteToB(target.email);
        await invitationModel.updateOne(
          { _id: new Types.ObjectId(expired.id) },
          { expiresAt: new Date(Date.now() - 1000) },
        );
        const res = await accept(target.jwt, {
          token: expired.token,
          consent: true,
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVITATION_INVALID_OR_EXPIRED');
        await invitationModel.updateOne(
          { _id: new Types.ObjectId(expired.id) },
          { status: 'expired' },
        );

        const revoked = await inviteToB(target.email);
        await revoke(ownerBToken, revoked.id);
        const resRevoked = await accept(target.jwt, {
          token: revoked.token,
          consent: true,
        });
        expect(resRevoked.status).toBe(400);
        expect(resRevoked.body.code).toBe('INVITATION_INVALID_OR_EXPIRED');

        const suspended = await inviteToB(target.email);
        await organizationModel.updateOne(
          { _id: new Types.ObjectId(orgBId) },
          { status: 'suspended' },
        );
        try {
          for (const resSuspended of [
            await inspect(target.jwt, { token: suspended.token }),
            await accept(target.jwt, { token: suspended.token, consent: true }),
          ]) {
            expect(resSuspended.status).toBe(400);
            expect(resSuspended.body.code).toBe(
              'INVITATION_INVALID_OR_EXPIRED',
            );
          }
        } finally {
          await organizationModel.updateOne(
            { _id: new Types.ObjectId(orgBId) },
            { status: 'active' },
          );
        }
        expect(await invitationStatus(suspended.id)).toBe('pending');
        expect(await membershipsInB(target.id)).toBe(0);
      });

      it('membership déjà existante (même révoquée) → 409, invitation non consommée, aucune réactivation', async () => {
        const target = await existingAccount('member');
        await membershipModel.create({
          organizationId: new Types.ObjectId(orgBId),
          userId: target.id,
          role: 'seller',
          status: 'revoked',
        });
        const invitation = await inviteToB(target.email, { role: 'admin' });
        const preview = await inspect(target.jwt, { token: invitation.token });
        expect(preview.status).toBe(409);
        const res = await accept(target.jwt, {
          token: invitation.token,
          consent: true,
        });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('MEMBERSHIP_ALREADY_EXISTS');
        expect(await invitationStatus(invitation.id)).toBe('pending');
        const membership = await membershipModel
          .findOne({
            organizationId: new Types.ObjectId(orgBId),
            userId: target.id,
          })
          .exec();
        expect(membership!.status).toBe('revoked');
      });

      it('acceptations concurrentes (même session, même token) : une seule réussite, une seule membership', async () => {
        const target = await existingAccount('race');
        const invitation = await inviteToB(target.email);
        const body = { token: invitation.token, consent: true };
        const [a, b] = await Promise.all([
          accept(target.jwt, body),
          accept(target.jwt, body),
        ]);
        expect([a.status, b.status].sort()).toEqual([200, 400]);
        expect(await membershipsInB(target.id)).toBe(1);
      }, 20_000);
    });

    describe('nouveau compte : lien envoyé à l’adresse invitée', () => {
      it('demande du lien : réponse identique (statut et corps) que l’adresse ait un compte ou non ; aucun envoi pour un compte existant', async () => {
        const target = await existingAccount('link-existing');
        const existing = await inviteToB(target.email);
        const freshEmail = `link-new-${Date.now()}@royalvibe.test`;
        const fresh = await inviteToB(freshEmail);

        const a = await accountLink(existing.token);
        const b = await accountLink(fresh.token);
        expect(a.status).toBe(202);
        expect(b.status).toBe(202);
        expect(a.body).toEqual(b.body);
        expect(JSON.stringify(a.body)).not.toContain(target.name);

        await waitFor(() => emailSender.sentTo(freshEmail).length === 1);
        // Laisse au traitement différé du compte existant le temps d'agir.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(emailSender.sentTo(target.email)).toHaveLength(0);
        // Aucune écriture : aucune membership, invitations toujours en attente.
        expect(await invitationStatus(existing.id)).toBe('pending');
        expect(await invitationStatus(fresh.id)).toBe('pending');
        expect(await userModel.countDocuments({ email: freshEmail })).toBe(0);
      });

      it('le lien du créateur ne crée jamais de compte : create-account avec ce lien → 400, aucune écriture', async () => {
        const email = `creator-link-${Date.now()}@royalvibe.test`;
        const invitation = await inviteToB(email);
        const res = await createAccount({
          token: invitation.token,
          name: 'Usurpateur',
          password: 'creator-pw-!1x',
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVITATION_INVALID_OR_EXPIRED');
        expect(await userModel.countDocuments({ email })).toBe(0);
        expect(await invitationStatus(invitation.id)).toBe('pending');
      });

      it('parcours complet : lien reçu à l’adresse, compte vérifié créé par la personne qui l’ouvre, membership exacte, preuve légale, connexion', async () => {
        const email = `new-account-${Date.now()}@royalvibe.test`;
        const invitation = await inviteToB(email, {
          role: 'admin',
          permissions: ['analytics.read'],
        });
        // Espaces de bord conservés : le mot de passe n'est jamais trimé.
        const password = '  new-account pw !1  ';
        const res = await createInvitedAccount(
          server(),
          emailSender,
          invitation.token,
          email,
          { name: '  Nouvelle  ', password },
        );
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          user: { email },
          organization: { name: 'Org B 16B1' },
        });

        const user = await userModel
          .findOne({ email })
          .select('+password')
          .exec();
        expect(user!.name).toBe('Nouvelle');
        expect(user!.role).toBe('seller'); // jamais promu
        expect(user!.emailVerifiedAt).toBeInstanceOf(Date);
        await expect(bcrypt.compare(password, user!.password)).resolves.toBe(
          true,
        );
        const membership = await membershipModel
          .findOne({
            organizationId: new Types.ObjectId(orgBId),
            userId: user!._id,
          })
          .exec();
        expect(membership!.role).toBe('admin');
        expect(membership!.permissions).toEqual(['analytics.read']);
        expect(await invitationStatus(invitation.id)).toBe('deleted');
        // Supprimée avec ses deux liens : aucun jeton conservé.
        const stored = await invitationModel
          .findById(invitation.id)
          .select('+accountTokenHash +accountTokenExpiresAt')
          .lean()
          .exec();
        expect(stored).toBeNull();

        // Aucun nouvel e-mail de vérification : l'adresse est déjà prouvée.
        expect(
          emailSender
            .sentTo(email)
            .filter((m) => m.text.includes('/auth/verify-email')),
        ).toHaveLength(0);
        const trimmed = await request(server())
          .post('/auth/login')
          .send({ email, password: password.trim() });
        expect(trimmed.status).toBe(401);
        const loginRes = await request(server())
          .post('/auth/login')
          .send({ email, password });
        expect(loginRes.status).toBe(201);
        const payload = jwtService.decode(String(loginRes.body.access_token));
        expect(String(payload.orgId)).toBe(orgBId);

        // Les deux liens sont désormais inutilisables.
        expect((await accountLink(invitation.token)).status).toBe(400);
      });

      it('mot de passe choisi APRÈS le lien : aucun compte avant la création, connexion impossible avec un mot de passe du créateur', async () => {
        const email = `no-oracle-${Date.now()}@royalvibe.test`;
        const invitation = await inviteToB(email);
        expect((await accountLink(invitation.token)).status).toBe(202);
        await waitFor(() => emailSender.sentTo(email).length === 1);
        expect(await userModel.countDocuments({ email })).toBe(0);
        const probe = await request(server())
          .post('/auth/login')
          .send({ email, password: 'creator-guess-!1' });
        expect(probe.status).toBe(401);
      });

      it('compte créé entre-temps pour l’adresse : 409 à la personne qui contrôle la boîte, invitation et lien conservés', async () => {
        const email = `raced-${Date.now()}@royalvibe.test`;
        const invitation = await inviteToB(email);
        const accountToken = await requestAccountToken(
          server(),
          emailSender,
          invitation.token,
          email,
        );
        await userModel.create({
          emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
          name: 'Déjà là',
          email,
          password: await bcrypt.hash(PASSWORD, 10),
        });
        const res = await createAccount({
          token: accountToken,
          name: 'Nouveau',
          password: 'raced-pw-!1x',
        });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('INVITATION_ACCOUNT_EXISTS');
        expect(await invitationStatus(invitation.id)).toBe('pending');
      });

      it('cooldown, envois concurrents, remplacement du lien, plafond par invitation', async () => {
        const email = `link-limits-${Date.now()}@royalvibe.test`;
        const invitation = await inviteToB(email);
        const [a, b] = await Promise.all([
          accountLink(invitation.token),
          accountLink(invitation.token),
        ]);
        expect([a.status, b.status]).toEqual([202, 202]);
        await waitFor(() => emailSender.sentTo(email).length >= 1);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(emailSender.sentTo(email)).toHaveLength(1);
        const first = accountTokenFrom(emailSender.sentTo(email)[0]);

        // Cooldown : rien de plus dans les 60 s.
        expect((await accountLink(invitation.token)).status).toBe(202);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(emailSender.sentTo(email)).toHaveLength(1);

        // Après le cooldown : nouveau lien, l'ancien est remplacé.
        await invitationModel.updateOne(
          { _id: new Types.ObjectId(invitation.id) },
          { accountLinkLastSentAt: new Date(Date.now() - 61_000) },
        );
        expect((await accountLink(invitation.token)).status).toBe(202);
        await waitFor(() => emailSender.sentTo(email).length === 2);
        const second = accountTokenFrom(emailSender.sentTo(email)[1]);
        expect(second).not.toBe(first);
        const stale = await createAccount({
          token: first,
          name: 'Ancien',
          password: 'stale-pw-!1x',
        });
        expect(stale.status).toBe(400);

        // Plafond : au-delà de 5 envois pour cette invitation, plus rien.
        await invitationModel.updateOne(
          { _id: new Types.ObjectId(invitation.id) },
          {
            accountLinkLastSentAt: new Date(Date.now() - 61_000),
            accountLinkSendCount: 5,
          },
        );
        expect((await accountLink(invitation.token)).status).toBe(202);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(emailSender.sentTo(email)).toHaveLength(2);
      });

      it('lien de création expiré, invitation révoquée ou expirée, déjà utilisée → 400, rien écrit', async () => {
        const email = `link-states-${Date.now()}@royalvibe.test`;
        const invitation = await inviteToB(email);
        const token = await requestAccountToken(
          server(),
          emailSender,
          invitation.token,
          email,
        );
        const body = { token, name: 'États', password: 'states-pw-!1x' };

        await invitationModel.updateOne(
          { _id: new Types.ObjectId(invitation.id) },
          { accountTokenExpiresAt: new Date(Date.now() - 1000) },
        );
        expect((await createAccount(body)).status).toBe(400);

        await invitationModel.updateOne(
          { _id: new Types.ObjectId(invitation.id) },
          { accountTokenExpiresAt: new Date(Date.now() + 60_000) },
        );
        await revoke(ownerBToken, invitation.id);
        expect((await createAccount(body)).status).toBe(400);
        expect(await userModel.countDocuments({ email })).toBe(0);

        // Lien borné par l'expiration de l'invitation (jamais au-delà).
        const shortEmail = `link-short-${Date.now()}@royalvibe.test`;
        const short = await inviteToB(shortEmail);
        const shortExpiry = new Date(Date.now() + 5 * 60_000);
        await invitationModel.updateOne(
          { _id: new Types.ObjectId(short.id) },
          { expiresAt: shortExpiry },
        );
        await requestAccountToken(
          server(),
          emailSender,
          short.token,
          shortEmail,
        );
        const stored = await invitationModel
          .findById(short.id)
          .select('+accountTokenExpiresAt')
          .lean()
          .exec();
        expect(stored!.accountTokenExpiresAt!.getTime()).toBeLessThanOrEqual(
          shortExpiry.getTime(),
        );
      });

      it('créations concurrentes (même lien) : une seule réussite, un seul compte', async () => {
        const email = `create-race-${Date.now()}@royalvibe.test`;
        const invitation = await inviteToB(email);
        const token = await requestAccountToken(
          server(),
          emailSender,
          invitation.token,
          email,
        );
        const body = { token, name: 'Course', password: 'race-pw-!1x' };
        const [a, b] = await Promise.all([
          createAccount(body),
          createAccount(body),
        ]);
        expect([a.status, b.status].sort()).toEqual([200, 400]);
        expect(await userModel.countDocuments({ email })).toBe(1);
      }, 20_000);

      it('échec après création User + Membership (garde finale) → rollback complet, invitation et lien conservés', async () => {
        const email = `create-rollback-${Date.now()}@royalvibe.test`;
        const invitation = await inviteToB(email);
        const token = await requestAccountToken(
          server(),
          emailSender,
          invitation.token,
          email,
        );
        const originalCount = membershipModel.countDocuments.bind(
          membershipModel,
        ) as (
          filter?: unknown,
          opts?: { session?: unknown },
        ) => Promise<number>;
        membershipModel.countDocuments = ((
          filter?: unknown,
          opts?: { session?: unknown },
        ) =>
          opts?.session
            ? Promise.resolve(2)
            : originalCount(
                filter,
                opts,
              )) as unknown as typeof membershipModel.countDocuments;
        let res: request.Response;
        try {
          res = await createAccount({
            token,
            name: 'Rollback',
            password: 'rollback-pw-!1x',
          });
        } finally {
          membershipModel.countDocuments =
            originalCount as unknown as typeof membershipModel.countDocuments;
        }
        expect(res.status).toBeGreaterThanOrEqual(500);
        expect(await userModel.countDocuments({ email })).toBe(0);
        expect(await invitationStatus(invitation.id)).toBe('pending');
        const retry = await createAccount({
          token,
          name: 'Rollback',
          password: 'rollback-pw-!1x',
        });
        expect(retry.status).toBe(200);
      });

      it('création indépendante de PUBLIC_REGISTRATION_ENABLED ; champs interdits → 400 sans écriture', async () => {
        delete process.env.PUBLIC_REGISTRATION_ENABLED;
        try {
          const email = `closed-${Date.now()}@royalvibe.test`;
          const invitation = await inviteToB(email);
          const token = await requestAccountToken(
            server(),
            emailSender,
            invitation.token,
            email,
          );
          const forbidden = await createAccount({
            token,
            name: 'F',
            password: 'closed-pw-!1x',
            role: 'owner',
          });
          expect(forbidden.status).toBe(400);
          expect(await userModel.countDocuments({ email })).toBe(0);
          const ok = await createAccount({
            token,
            name: 'Fermé',
            password: 'closed-pw-!1x',
          });
          expect(ok.status).toBe(200);
        } finally {
          process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
        }
      });
    });

    describe('compte existant sans organisation active : identifiants et accord explicite', () => {
      const credentials = (
        action: 'inspect' | 'accept',
        body: Record<string, unknown>,
      ) =>
        request(server())
          .post(`/auth/invitations/credentials/${action}`)
          .send(body);

      /** Compte vérifié dont la seule membership est révoquée : aucun JWT possible. */
      async function orphanAccount(label: string, verified = true) {
        seq += 1;
        const email = `${label}-${seq}-${Date.now()}@royalvibe.test`;
        const user = await userModel.create({
          ...(verified ? { emailVerifiedAt: E2E_EMAIL_VERIFIED_AT } : {}),
          name: `Orphelin ${seq}`,
          email,
          password: await bcrypt.hash(PASSWORD, 10),
        });
        await membershipModel.create({
          organizationId: new Types.ObjectId(orgAId),
          userId: user._id,
          role: 'seller',
          status: 'revoked',
        });
        return { email, name: user.name, id: user._id };
      }

      it('avant l’adhésion : connexion refusée, aucune route métier, aucun jeton délivré par l’aperçu', async () => {
        const target = await orphanAccount('orphan-before');
        const invitation = await inviteToB(target.email);
        const denied = await login(target.email);
        expect(denied.status).toBe(403);
        expect(denied.body.code).toBe('ORGANIZATION_ACCESS_DENIED');
        expect(denied.body.access_token).toBeUndefined();

        const preview = await credentials('inspect', {
          token: invitation.token,
          email: target.email,
          password: PASSWORD,
        });
        expect(preview.status).toBe(200);
        expect(preview.body).toEqual({
          organization: { name: 'Org B 16B1' },
          role: 'seller',
        });
        expect(JSON.stringify(preview.body)).not.toMatch(/token/i);
        expect(await invitationStatus(invitation.id)).toBe('pending');
        expect((await request(server()).get('/auth/context')).status).toBe(401);
      });

      it('mauvais identifiants (mot de passe, adresse inconnue, mot de passe changé) : 401 identiques au login, rien consommé', async () => {
        const target = await orphanAccount('orphan-bad');
        const invitation = await inviteToB(target.email);
        const loginRefusal = await request(server())
          .post('/auth/login')
          .send({ email: target.email, password: 'wrong-password-x' });
        const variants = [
          { email: target.email, password: 'wrong-password-x' },
          { email: `unknown-${Date.now()}@royalvibe.test`, password: PASSWORD },
        ];
        for (const action of ['inspect', 'accept'] as const) {
          for (const variant of variants) {
            const res = await credentials(action, {
              token: invitation.token,
              ...(action === 'accept' ? { consent: true } : {}),
              ...variant,
            });
            expect(res.status).toBe(401);
            expect(res.body.message).toBe(loginRefusal.body.message);
            expect(JSON.stringify(res.body)).not.toContain(target.name);
          }
        }
        // Mot de passe changé (réinitialisation) : l'ancien ne prouve plus rien.
        await userModel.updateOne(
          { _id: target.id },
          { password: await bcrypt.hash('new-password-!1x', 10) },
        );
        const stale = await credentials('accept', {
          token: invitation.token,
          email: target.email,
          password: PASSWORD,
          consent: true,
        });
        expect(stale.status).toBe(401);
        expect(await invitationStatus(invitation.id)).toBe('pending');
        expect(await membershipsInB(target.id)).toBe(0);
      });

      it('adresse non vérifiée : 403 EMAIL_NOT_VERIFIED après le mot de passe, rien consommé', async () => {
        const target = await orphanAccount('orphan-unverified', false);
        const invitation = await inviteToB(target.email);
        const res = await credentials('accept', {
          token: invitation.token,
          email: target.email,
          password: PASSWORD,
          consent: true,
        });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
        expect(await invitationStatus(invitation.id)).toBe('pending');
        expect(await membershipsInB(target.id)).toBe(0);
      });

      it('mauvais compte (identifiants valides d’une autre adresse) : 403, rien consommé, aucun nom', async () => {
        const target = await orphanAccount('orphan-target');
        const other = await orphanAccount('orphan-other');
        const invitation = await inviteToB(target.email);
        for (const action of ['inspect', 'accept'] as const) {
          const res = await credentials(action, {
            token: invitation.token,
            email: other.email,
            password: PASSWORD,
            ...(action === 'accept' ? { consent: true } : {}),
          });
          expect(res.status).toBe(403);
          expect(res.body.code).toBe('INVITATION_ACCOUNT_MISMATCH');
          expect(JSON.stringify(res.body)).not.toContain(target.name);
          expect(JSON.stringify(res.body)).not.toContain(target.email);
        }
        expect(await invitationStatus(invitation.id)).toBe('pending');
        expect(await membershipsInB(other.id)).toBe(0);
      });

      it('accord absent, faux ou mal typé : 400, rien consommé', async () => {
        const target = await orphanAccount('orphan-consent');
        const invitation = await inviteToB(target.email);
        for (const consent of [undefined, false, 'true']) {
          const res = await credentials('accept', {
            token: invitation.token,
            email: target.email,
            password: PASSWORD,
            ...(consent === undefined ? {} : { consent }),
          });
          expect(res.status).toBe(400);
        }
        expect(await invitationStatus(invitation.id)).toBe('pending');
        expect(await membershipsInB(target.id)).toBe(0);
      });

      it('acceptation réussie : aucun jeton délivré, membership exacte, puis connexion normale à B uniquement', async () => {
        const target = await orphanAccount('orphan-ok');
        const invitation = await inviteToB(target.email, {
          permissions: ['analytics.read'],
        });
        const res = await credentials('accept', {
          token: invitation.token,
          email: target.email,
          password: PASSWORD,
          consent: true,
        });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          organization: {
            _id: orgBId,
            name: 'Org B 16B1',
            slug: expect.any(String),
          },
          membership: { role: 'seller', status: 'active' },
        });
        expect(await invitationStatus(invitation.id)).toBe('deleted');
        const membership = await membershipModel
          .findOne({
            organizationId: new Types.ObjectId(orgBId),
            userId: target.id,
          })
          .exec();
        expect(membership!.permissions).toEqual(['analytics.read']);
        // L'ancienne membership révoquée n'est jamais réactivée.
        const inA = await membershipModel
          .findOne({
            organizationId: new Types.ObjectId(orgAId),
            userId: target.id,
          })
          .exec();
        expect(inA!.status).toBe('revoked');

        const replay = await credentials('accept', {
          token: invitation.token,
          email: target.email,
          password: PASSWORD,
          consent: true,
        });
        expect(replay.status).toBe(400);

        const loginRes = await login(target.email);
        expect(loginRes.status).toBe(201);
        const payload = jwtService.decode(String(loginRes.body.access_token));
        expect(String(payload.orgId)).toBe(orgBId);
        const context = await request(server())
          .get('/auth/context')
          .set('Authorization', `Bearer ${loginRes.body.access_token}`);
        expect(context.status).toBe(200);
        expect(context.body.organizationId).toBe(orgBId);
        expect((await login(target.email, orgAId)).status).toBe(403);
      });

      it('limitation PARTAGÉE avec le login : aucun essai de mot de passe supplémentaire par IP', async () => {
        const target = await orphanAccount('orphan-rl');
        const invitation = await inviteToB(target.email);
        clearThrottle();
        for (let i = 0; i < 6; i++) {
          const res = await request(server())
            .post('/auth/login')
            .send({ email: target.email, password: 'wrong-password-x' });
          expect(res.status).toBe(401);
        }
        const statuses: number[] = [];
        for (let i = 0; i < 5; i++) {
          statuses.push(
            (
              await credentials('inspect', {
                token: invitation.token,
                email: target.email,
                password: 'wrong-password-x',
              })
            ).status,
          );
        }
        // 6 + 4 = 10 essais autorisés ; le 11ᵉ (5ᵉ ici) est refusé.
        expect(statuses).toEqual([401, 401, 401, 401, 429]);
        const blockedLogin = await login(target.email);
        expect(blockedLogin.status).toBe(429);
        expect(blockedLogin.body.code).toBe(AUTH_RATE_LIMIT_CODE);
      });
    });

    it('limitation par IP existante (429) sur les routes publiques d’invitation', async () => {
      for (const path of [
        '/auth/invitations/account-link',
        '/auth/invitations/create-account',
      ]) {
        clearThrottle();
        let last: request.Response | undefined;
        for (let i = 0; i < 11; i++) {
          last = await request(server())
            .post(path)
            .send({ token: `rl-${i}-${Date.now()}` });
        }
        expect(last!.status).toBe(429);
        expect(last!.body.code).toBe(AUTH_RATE_LIMIT_CODE);
      }
    });
  });
});
