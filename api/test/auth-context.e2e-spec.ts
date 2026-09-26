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
 * E2E (1-9C) — `GET /auth/context`. Source unique et fiable des droits de
 * l'organisation courante pour le frontend : vérifie l'isolation
 * multi-organisation, l'exclusion des memberships/organisations non
 * actives (même 403 uniforme que le reste des routes protégées — cette
 * route N'A PAS `@SkipOrganizationContext`), et le calcul correct des
 * permissions effectives (rôle ∪ permissions supplémentaires).
 */

const TEST_JWT_SECRET = 'auth-context-e2e-only-secret';
const E2E_CORS_ORIGIN = 'https://auth-context-e2e.example.com';
const PASSWORD = 'auth-context-19c-pw-!1x';

const OWNER_EMAIL = 'owner-19c@royalvibe.test';
const SELLER_WITH_EXTRA_EMAIL = 'seller-extra-19c@royalvibe.test';
const SUSPENDED_MEMBER_EMAIL = 'suspended-member-19c@royalvibe.test';
const STRANDED_OWNER_EMAIL = 'stranded-19c@royalvibe.test';

// `res.body` (supertest) est typé `any` : jamais assigner/lire une valeur
// `any` directement (`no-unsafe-*`) — la forme est validée explicitement
// avant tout accès aux tableaux de permissions.
interface AuthContextResponseBody {
  permissions: string[];
  effectivePermissions: string[];
}

function assertAuthContextBody(
  body: unknown,
): asserts body is AuthContextResponseBody {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Forme de réponse /auth/context inattendue');
  }
  const candidate = body as Record<string, unknown>;
  if (
    !Array.isArray(candidate.permissions) ||
    !Array.isArray(candidate.effectivePermissions)
  ) {
    throw new Error('Forme de réponse /auth/context inattendue');
  }
}

describe('GET /auth/context (e2e 1-9C)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let userModel: Model<UserDocument>;
  let organizationModel: Model<OrganizationDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;

  let orgId = '';
  let ownerToken = '';
  let sellerExtraToken = '';
  let suspendedMemberToken = '';
  let strandedToken = '';

  const getContext = (token: string) =>
    request(app.getHttpServer())
      .get('/auth/context')
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

      const reg = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Owner',
          email: OWNER_EMAIL,
          password: PASSWORD,
          organizationName: 'Context Org 19C',
        });
      expect(reg.status).toBe(201);
      orgId = reg.body.organization._id as string;

      const loginOwner = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: OWNER_EMAIL, password: PASSWORD });
      expect(loginOwner.status).toBe(201);
      ownerToken = loginOwner.body.access_token as string;

      // Seller avec une permission supplémentaire déléguée (au-delà des
      // permissions par défaut du rôle) — vérifie l'union rôle ∪ extra.
      const sellerExtra = await userModel.create({
        name: 'Seller Extra',
        email: SELLER_WITH_EXTRA_EMAIL,
        password: await bcrypt.hash(PASSWORD, 10),
      });
      await membershipModel.create({
        organizationId: new Types.ObjectId(orgId),
        userId: sellerExtra._id,
        role: 'seller',
        status: 'active',
        permissions: ['analytics.read'],
      });
      const loginSellerExtra = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: SELLER_WITH_EXTRA_EMAIL, password: PASSWORD });
      expect(loginSellerExtra.status).toBe(201);
      sellerExtraToken = loginSellerExtra.body.access_token as string;

      // Membership suspendue : le token est émis PENDANT qu'elle est
      // active, puis suspendue — même convention que les autres specs 1-9.
      const suspendedMember = await userModel.create({
        name: 'Suspended Member',
        email: SUSPENDED_MEMBER_EMAIL,
        password: await bcrypt.hash(PASSWORD, 10),
      });
      await membershipModel.create({
        organizationId: new Types.ObjectId(orgId),
        userId: suspendedMember._id,
        role: 'seller',
        status: 'active',
      });
      const loginSuspendedMember = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: SUSPENDED_MEMBER_EMAIL, password: PASSWORD });
      expect(loginSuspendedMember.status).toBe(201);
      suspendedMemberToken = loginSuspendedMember.body.access_token as string;
      await membershipModel.updateOne(
        {
          organizationId: new Types.ObjectId(orgId),
          userId: suspendedMember._id,
        },
        { $set: { status: 'suspended' } },
      );

      // Organisation courante suspendue APRÈS émission du token : cette
      // route N'EST PAS `@SkipOrganizationContext` — doit rester 403.
      const regStranded = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Stranded Owner',
          email: STRANDED_OWNER_EMAIL,
          password: PASSWORD,
          organizationName: 'Stranded Context Org 19C',
        });
      expect(regStranded.status).toBe(201);
      const strandedOrgId = regStranded.body.organization._id as string;
      const loginStranded = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: STRANDED_OWNER_EMAIL, password: PASSWORD });
      expect(loginStranded.status).toBe(201);
      strandedToken = loginStranded.body.access_token as string;
      await organizationModel.updateOne(
        { _id: strandedOrgId },
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
    const res = await request(app.getHttpServer()).get('/auth/context');
    expect(res.status).toBe(401);
  });

  it('owner : role owner, effectivePermissions = tout le délégable, jamais membershipId', async () => {
    const res = await getContext(ownerToken);
    expect(res.status).toBe(200);
    expect(res.body.organizationId).toBe(orgId);
    expect(res.body.role).toBe('owner');
    expect(res.body.permissions).toEqual([]);
    expect(res.body.effectivePermissions).toEqual(
      expect.arrayContaining([
        'members.manage',
        'members.invite',
        'branding.manage',
      ]),
    );
    const body: unknown = res.body;
    assertAuthContextBody(body);
    expect(Object.keys(body).sort()).toEqual([
      'effectivePermissions',
      'organizationId',
      'permissions',
      'role',
      'userId',
    ]);
  });

  it('seller avec permission supplémentaire : effectivePermissions = défauts du rôle ∪ extra', async () => {
    const res = await getContext(sellerExtraToken);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('seller');
    expect(res.body.permissions).toEqual(['analytics.read']);
    const body: unknown = res.body;
    assertAuthContextBody(body);
    expect(body.effectivePermissions.sort()).toEqual(
      ['analytics.read', 'sales.record', 'sales.view_own'].sort(),
    );
    // jamais les permissions non accordées (ex. members.manage) :
    expect(body.effectivePermissions).not.toContain('members.manage');
  });

  it('membership suspendue → 403 ORGANIZATION_ACCESS_DENIED uniforme', async () => {
    const res = await getContext(suspendedMemberToken);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORGANIZATION_ACCESS_DENIED');
  });

  it('organisation courante suspendue → 403 (pas de @SkipOrganizationContext sur cette route)', async () => {
    const res = await getContext(strandedToken);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORGANIZATION_ACCESS_DENIED');
  });
});
