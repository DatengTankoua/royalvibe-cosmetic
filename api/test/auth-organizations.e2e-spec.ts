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
 * E2E (1-9B) — `GET /auth/organizations` + `POST /auth/switch-organization`,
 * sur `MongoMemoryReplSet` réel. Vérifie l'isolation par utilisateur,
 * l'exclusion des memberships/organisations non actives, l'absence de JWT,
 * et la correction ciblée `@SkipOrganizationContext` (ces deux routes
 * restent utilisables même quand l'organisation COURANTE du JWT devient
 * inactive, sans jamais rendre les autres routes protégées publiques).
 */

const TEST_JWT_SECRET = 'auth-organizations-e2e-only-secret';
const E2E_CORS_ORIGIN = 'https://auth-organizations-e2e.example.com';
const PASSWORD = 'auth-orgs-19b-pw-!1x';

const OWNER1_EMAIL = 'owner1-19b@royalvibe.test';
const OWNER2_EMAIL = 'owner2-19b@royalvibe.test';
const MULTI_USER_EMAIL = 'multi-19b@royalvibe.test';
const EXCLUDED_USER_EMAIL = 'excluded-19b@royalvibe.test';
const STRANDED_OWNER_EMAIL = 'stranded-19b@royalvibe.test';

describe('GET /auth/organizations + POST /auth/switch-organization (e2e 1-9B)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let userModel: Model<UserDocument>;
  let organizationModel: Model<OrganizationDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;

  let org1Id = '';
  let org2Id = '';
  let owner1Token = '';
  let multiUserToken = '';
  let excludedUserToken = '';
  // Org COURANTE du token (suspendue APRÈS émission) + org de repli active.
  let strandedFallbackOrgId = '';
  let strandedToken = '';

  const listOrgs = (token: string) =>
    request(app.getHttpServer())
      .get('/auth/organizations')
      .set('Authorization', `Bearer ${token}`);

  const switchOrg = (token: string, organizationId: string) =>
    request(app.getHttpServer())
      .post('/auth/switch-organization')
      .set('Authorization', `Bearer ${token}`)
      .send({ organizationId });

  const getCurrent = (token: string) =>
    request(app.getHttpServer())
      .get('/organizations/current')
      .set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = TEST_JWT_SECRET;
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

      const reg1 = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Owner 1',
          email: OWNER1_EMAIL,
          password: PASSWORD,
          organizationName: 'Zebra Org 19B',
        });
      expect(reg1.status).toBe(201);
      org1Id = reg1.body.organization._id as string;

      const reg2 = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Owner 2',
          email: OWNER2_EMAIL,
          password: PASSWORD,
          organizationName: 'Alpha Org 19B',
        });
      expect(reg2.status).toBe(201);
      org2Id = reg2.body.organization._id as string;

      // Organisation active mais dont TOUTES les memberships de
      // EXCLUDED_USER seront non actives / non pertinentes.
      const suspendedOrg = await organizationModel.create({
        name: 'Suspended Org 19B',
        slug: 'suspended-org-19b',
        status: 'suspended',
      });
      const activeOrgWithSuspendedMembership = await organizationModel.create({
        name: 'Active Org Suspended Membership 19B',
        slug: 'active-org-suspended-membership-19b',
        status: 'active',
      });

      const loginOwner1 = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: OWNER1_EMAIL, password: PASSWORD });
      expect(loginOwner1.status).toBe(201);
      owner1Token = loginOwner1.body.access_token as string;

      // MULTI_USER : membership active dans org1 ET org2 (noms triés :
      // "Alpha Org 19B" < "Zebra Org 19B").
      const multiUser = await userModel.create({
        name: 'Multi User',
        email: MULTI_USER_EMAIL,
        password: await bcrypt.hash(PASSWORD, 10),
      });
      await membershipModel.create({
        organizationId: new Types.ObjectId(org1Id),
        userId: multiUser._id,
        role: 'seller',
        status: 'active',
      });
      await membershipModel.create({
        organizationId: new Types.ObjectId(org2Id),
        userId: multiUser._id,
        role: 'seller',
        status: 'active',
      });
      const loginMultiUser = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: MULTI_USER_EMAIL,
          password: PASSWORD,
          organizationId: org1Id,
        });
      expect(loginMultiUser.status).toBe(201);
      multiUserToken = loginMultiUser.body.access_token as string;

      // EXCLUDED_USER : membership active dans org1 (token valide),
      // + membership active dans une organisation SUSPENDUE (exclue),
      // + membership SUSPENDUE dans une organisation active (exclue).
      const excludedUser = await userModel.create({
        name: 'Excluded User',
        email: EXCLUDED_USER_EMAIL,
        password: await bcrypt.hash(PASSWORD, 10),
      });
      await membershipModel.create({
        organizationId: new Types.ObjectId(org1Id),
        userId: excludedUser._id,
        role: 'seller',
        status: 'active',
      });
      await membershipModel.create({
        organizationId: suspendedOrg._id,
        userId: excludedUser._id,
        role: 'seller',
        status: 'active',
      });
      await membershipModel.create({
        organizationId: activeOrgWithSuspendedMembership._id,
        userId: excludedUser._id,
        role: 'seller',
        status: 'suspended',
      });
      const loginExcludedUser = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: EXCLUDED_USER_EMAIL,
          password: PASSWORD,
          organizationId: org1Id,
        });
      expect(loginExcludedUser.status).toBe(201);
      excludedUserToken = loginExcludedUser.body.access_token as string;

      // STRANDED_OWNER : token émis pour SA propre org pendant qu'elle est
      // ENCORE active, une org de repli active, PUIS l'org du token est
      // suspendue — même convention que organization-branding.e2e-spec.ts
      // ("membership/organisation suspendue APRÈS émission du token").
      const regStranded = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Stranded Owner',
          email: STRANDED_OWNER_EMAIL,
          password: PASSWORD,
          organizationName: 'Stranded Current Org 19B',
        });
      expect(regStranded.status).toBe(201);
      const strandedCurrentOrgId = regStranded.body.organization._id as string;
      const strandedUserId = regStranded.body.user._id as string;

      const strandedFallbackOrg = await organizationModel.create({
        name: 'Stranded Fallback Org 19B',
        slug: 'stranded-fallback-org-19b',
        status: 'active',
      });
      strandedFallbackOrgId = strandedFallbackOrg._id.toString();
      await membershipModel.create({
        organizationId: strandedFallbackOrg._id,
        userId: new Types.ObjectId(strandedUserId),
        role: 'seller',
        status: 'active',
      });

      const loginStranded = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: STRANDED_OWNER_EMAIL,
          password: PASSWORD,
          organizationId: strandedCurrentOrgId,
        });
      expect(loginStranded.status).toBe(201);
      strandedToken = loginStranded.body.access_token as string;

      // Suspendue APRÈS l'émission du token : le JWT reste signé pour cette
      // org, mais elle n'est plus active.
      await organizationModel.updateOne(
        { _id: strandedCurrentOrgId },
        { $set: { status: 'suspended' } },
      );
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

  it('sans JWT → 401', async () => {
    const res = await request(app.getHttpServer()).get('/auth/organizations');
    expect(res.status).toBe(401);
  });

  it('isolation : owner1 ne voit que son organisation, jamais org2', async () => {
    const res = await listOrgs(owner1Token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { organizationId: org1Id, name: 'Zebra Org 19B' },
    ]);
  });

  it('multi-organisation : les deux organisations actives, triées par nom', async () => {
    const res = await listOrgs(multiUserToken);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { organizationId: org2Id, name: 'Alpha Org 19B' },
      { organizationId: org1Id, name: 'Zebra Org 19B' },
    ]);
  });

  it('exclut organisation suspendue et membership suspendue, jamais membershipId/rôle/permissions', async () => {
    const res = await listOrgs(excludedUserToken);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { organizationId: org1Id, name: 'Zebra Org 19B' },
    ]);
    const body = res.body as Record<string, unknown>[];
    for (const org of body) {
      expect(Object.keys(org).sort()).toEqual(['name', 'organizationId']);
    }
  });

  // ---- correction ciblée : org courante suspendue (@SkipOrganizationContext) ----

  it('organisation courante suspendue : GET /auth/organizations renvoie 200 et ne liste QUE les autres organisations actives', async () => {
    const res = await listOrgs(strandedToken);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        organizationId: strandedFallbackOrgId,
        name: 'Stranded Fallback Org 19B',
      },
    ]);
  });

  it('organisation courante suspendue : switch vers une AUTRE organisation active → 200', async () => {
    const res = await switchOrg(strandedToken, strandedFallbackOrgId);
    expect(res.status).toBe(200);
    expect(typeof res.body.access_token).toBe('string');
  });

  it('switch vers une organisation inaccessible/inexistante → 403 uniforme, même depuis une org courante suspendue', async () => {
    // org2Id existe et est active, mais STRANDED_OWNER n'y a AUCUNE membership.
    const res = await switchOrg(strandedToken, org2Id);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORGANIZATION_ACCESS_DENIED');
  });

  it('sans JWT sur POST /auth/switch-organization → 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/switch-organization')
      .send({ organizationId: org1Id });
    expect(res.status).toBe(401);
  });

  it("régression : une route protégée SANS @SkipOrganizationContext (GET /organizations/current) reste bloquée par l'organisation courante suspendue", async () => {
    const res = await getCurrent(strandedToken);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORGANIZATION_ACCESS_DENIED');
  });
});
