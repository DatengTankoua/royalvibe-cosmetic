import 'reflect-metadata';
import type { AddressInfo } from 'net';
import { Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument } from './../src/users/schemas/user.schema';
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
 * E2E (1-7C) — gestion des membres + transfert de propriété, sur
 * `MongoMemoryReplSet` réel (les transactions l'exigent) + un vrai serveur
 * Socket.IO attaché (`app.listen(0)`) pour observer les déconnexions
 * forcées après commit.
 */

const TEST_JWT_SECRET = 'membership-mgmt-e2e-only-secret';
const E2E_CORS_ORIGIN = 'https://membership-e2e.example.com';
const PASSWORD = 'membership-17c-pw-!1x';

let port: number;

interface CreatedMemberFixture {
  userId: string;
  membershipId: string;
  token: string;
}

describe('Gestion des membres + transfert de propriété (e2e 1-7C)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let userModel: Model<UserDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;

  let orgAId = '';
  let orgBId = '';
  let orgDId = '';
  let ownerAToken = '';
  let ownerDToken = '';
  let adminAToken = '';
  let delegatedSellerToken = '';
  let targetSellerToken = '';

  let adminAMembershipId = '';
  let targetSellerMembershipId = '';
  let orgBMembershipId = '';
  let transferTargetMembershipId = '';

  const register = (name: string, email: string, organizationName: string) =>
    request(app.getHttpServer())
      .post('/auth/register')
      .send({ name, email, password: PASSWORD, organizationName });
  const login = (email: string, organizationId: string) =>
    request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD, organizationId });
  const listMembers = (token: string) =>
    request(app.getHttpServer())
      .get('/organizations/members')
      .set('Authorization', `Bearer ${token}`);
  const patchMember = (
    token: string,
    id: string,
    body: Record<string, unknown>,
  ) =>
    request(app.getHttpServer())
      .patch(`/organizations/members/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const transferOwnership = (token: string, id: string) =>
    request(app.getHttpServer())
      .post(`/organizations/members/${id}/transfer-ownership`)
      .set('Authorization', `Bearer ${token}`);

  async function createMember(
    organizationId: string,
    name: string,
    email: string,
    role: 'admin' | 'seller',
    permissions: string[] = [],
  ): Promise<CreatedMemberFixture> {
    // Générés AVANT insertion : Mongoose infère `Model.create(doc)` avec un
    // type d'erreur sur `_id` pour ce schéma — jamais relire `doc._id`.
    const userId = new Types.ObjectId();
    const membershipId = new Types.ObjectId();
    await userModel.create({
      _id: userId,
      name,
      email,
      password: await bcrypt.hash(PASSWORD, 10),
    });
    await membershipModel.create({
      _id: membershipId,
      organizationId: new Types.ObjectId(organizationId),
      userId,
      role,
      status: 'active',
      permissions,
    });
    const loginRes = await login(email, organizationId);
    expect(loginRes.status).toBe(201);
    const token: unknown = loginRes.body.access_token;
    if (typeof token !== 'string') {
      throw new Error(
        'access_token manquant ou non-string dans la réponse de /auth/login',
      );
    }
    return {
      userId: userId.toHexString(),
      membershipId: membershipId.toHexString(),
      token,
    };
  }

  /** Connecte un client Socket.IO réel (WebSocket) avec un token valide. */
  function connectSocket(token: string): Socket {
    return io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 4_000,
      extraHeaders: { origin: E2E_CORS_ORIGIN },
      auth: { token },
    });
  }

  function waitForEvent(
    socket: Socket,
    event: 'connect' | 'disconnect',
    waitMs = 5_000,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${event} not received within ${waitMs}ms`)),
        waitMs,
      );
      socket.once(event, (arg: unknown) => {
        clearTimeout(timer);
        resolve(arg);
      });
    });
  }

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
      await app.listen(0);
      port = (app.getHttpServer().address() as AddressInfo).port;

      userModel = moduleFixture.get(getModelToken('User'));
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );

      const regA = await register(
        'Owner A',
        'owner-a-17c@royalvibe.test',
        'Org A 17C',
      );
      expect(regA.status).toBe(201);
      orgAId = regA.body.organization._id as string;
      const loginA = await login('owner-a-17c@royalvibe.test', orgAId);
      expect(loginA.status).toBe(201);
      ownerAToken = loginA.body.access_token as string;

      const regB = await register(
        'Owner B',
        'owner-b-17c@royalvibe.test',
        'Org B 17C',
      );
      expect(regB.status).toBe(201);
      orgBId = regB.body.organization._id as string;
      const loginB = await login('owner-b-17c@royalvibe.test', orgBId);
      expect(loginB.status).toBe(201);

      const regD = await register(
        'Owner D',
        'owner-d-17c@royalvibe.test',
        'Org D 17C',
      );
      expect(regD.status).toBe(201);
      orgDId = regD.body.organization._id as string;
      const loginD = await login('owner-d-17c@royalvibe.test', orgDId);
      expect(loginD.status).toBe(201);
      ownerDToken = loginD.body.access_token as string;

      const admin = await createMember(
        orgAId,
        'Admin A',
        'admin-a-17c@royalvibe.test',
        'admin',
      );
      adminAToken = admin.token;
      adminAMembershipId = admin.membershipId;

      const delegated = await createMember(
        orgAId,
        'Delegated Seller A',
        'delegated-a-17c@royalvibe.test',
        'seller',
        ['members.manage'],
      );
      delegatedSellerToken = delegated.token;

      const target = await createMember(
        orgAId,
        'Target Seller A',
        'target-a-17c@royalvibe.test',
        'seller',
      );
      targetSellerToken = target.token;
      targetSellerMembershipId = target.membershipId;

      const memberB = await createMember(
        orgBId,
        'Member B',
        'member-b-17c@royalvibe.test',
        'seller',
      );
      orgBMembershipId = memberB.membershipId;

      const transferTarget = await createMember(
        orgAId,
        'Transfer Target A',
        'transfer-target-17c@royalvibe.test',
        'seller',
      );
      transferTargetMembershipId = transferTarget.membershipId;
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

  it('1. GET /organizations/members : liste org A uniquement, org B jamais incluse', async () => {
    const res = await listMembers(ownerAToken);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ membershipId: string }>).map(
      (m) => m.membershipId,
    );
    expect(ids).toContain(adminAMembershipId);
    expect(ids).toContain(targetSellerMembershipId);
    expect(ids).not.toContain(orgBMembershipId);
    // Jamais password/User.role dans la réponse :
    for (const member of res.body as Array<Record<string, unknown>>) {
      expect(member.password).toBeUndefined();
      expect(member.userRole).toBeUndefined();
    }
  });

  it('2. seller sans members.manage → 403 PERMISSION_DENIED sur GET et PATCH', async () => {
    const listRes = await listMembers(targetSellerToken);
    expect(listRes.status).toBe(403);
    expect(listRes.body.code).toBe('PERMISSION_DENIED');

    const patchRes = await patchMember(targetSellerToken, adminAMembershipId, {
      status: 'suspended',
    });
    expect(patchRes.status).toBe(403);
    expect(patchRes.body.code).toBe('PERMISSION_DENIED');
  });

  it('3. délégation members.manage SANS escalade : gère un seller ordinaire, refuse d’escalader', async () => {
    // Le délégué (seller + permissions:['members.manage']) ne peut accorder
    // QUE des permissions qu'il possède déjà lui-même effectivement.
    const ok = await patchMember(
      delegatedSellerToken,
      targetSellerMembershipId,
      { permissions: ['members.manage'] },
    );
    expect(ok.status).toBe(200);
    expect(ok.body.permissions).toEqual(['members.manage']);
    // Restaure l'état d'origine de la cible.
    await patchMember(delegatedSellerToken, targetSellerMembershipId, {
      permissions: [],
    });

    // Ne peut pas s'attribuer (via la cible) plus que ses propres droits :
    const escalation = await patchMember(
      delegatedSellerToken,
      targetSellerMembershipId,
      { permissions: ['analytics.read'] },
    );
    expect(escalation.status).toBe(403);
    expect(escalation.body.code).toBe('PERMISSION_DENIED');

    // Ne peut pas gérer un membre ayant déjà plus de droits (admin) :
    const overPrivileged = await patchMember(
      delegatedSellerToken,
      adminAMembershipId,
      { status: 'suspended' },
    );
    expect(overPrivileged.status).toBe(403);
    expect(overPrivileged.body.code).toBe('PERMISSION_DENIED');
  });

  it('4. owner modifie librement rôle/permissions/statut d’un membre (reflété dans la liste)', async () => {
    const res = await patchMember(ownerAToken, targetSellerMembershipId, {
      role: 'admin',
      permissions: ['analytics.read'],
    });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
    expect(res.body.permissions).toEqual(['analytics.read']);

    const list = await listMembers(ownerAToken);
    const updated = (
      list.body as Array<{ membershipId: string; role: string }>
    ).find((m) => m.membershipId === targetSellerMembershipId);
    expect(updated?.role).toBe('admin');

    // Remet l'état d'origine pour les tests suivants.
    const reset = await patchMember(ownerAToken, targetSellerMembershipId, {
      role: 'seller',
      permissions: [],
    });
    expect(reset.status).toBe(200);
  });

  it('5. self-management et modification de l’owner refusés (403, codes stables)', async () => {
    const self = await patchMember(ownerAToken, adminAMembershipId, {
      status: 'suspended',
    });
    // adminA modifiant lui-même via son PROPRE token serait self-management ;
    // ici c'est owner qui cible admin (pas self) — on vérifie le vrai self :
    expect(self.status).toBe(200); // owner → admin : autorisé (pas self, pas owner cible)
    await patchMember(ownerAToken, adminAMembershipId, {
      status: 'active',
    }); // restaure

    const trueSelf = await patchMember(adminAToken, adminAMembershipId, {
      status: 'suspended',
    });
    expect(trueSelf.status).toBe(403);
    expect(trueSelf.body.code).toBe('SELF_MANAGEMENT_FORBIDDEN');

    // Trouve la membership OWNER de A via la liste, tente de la modifier :
    const list = await listMembers(ownerAToken);
    const ownerMembership = (
      list.body as Array<{ membershipId: string; role: string }>
    ).find((m) => m.role === 'owner')!;
    const ownerEdit = await patchMember(
      adminAToken,
      ownerMembership.membershipId,
      {
        status: 'suspended',
      },
    );
    expect(ownerEdit.status).toBe(403);
    expect(ownerEdit.body.code).toBe('OWNER_NOT_MANAGEABLE');
  });

  it('6. cible d’une AUTRE organisation → 404, identique à une cible absente', async () => {
    const foreign = await patchMember(ownerAToken, orgBMembershipId, {
      status: 'suspended',
    });
    const missing = await patchMember(
      ownerAToken,
      new Types.ObjectId().toString(),
      { status: 'suspended' },
    );
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
  });

  it('7. falsification organizationId dans le body PATCH → 400 (whitelist), aucun effet', async () => {
    const res = await patchMember(ownerAToken, targetSellerMembershipId, {
      status: 'active',
      organizationId: orgBId,
    });
    expect(res.status).toBe(400);
  });

  it('8. suspension bloque IMMÉDIATEMENT HTTP (OrganizationGuard) ET une NOUVELLE connexion socket', async () => {
    const suspend = await patchMember(ownerAToken, targetSellerMembershipId, {
      status: 'suspended',
    });
    expect(suspend.status).toBe(200);

    const httpAfter = await listMembers(targetSellerToken);
    expect(httpAfter.status).toBe(403);

    const socket = connectSocket(targetSellerToken);
    const err = await new Promise((resolve) => {
      socket.once('connect_error', (e: Error) => resolve(e.message));
      socket.once('connect', () => resolve('connected'));
    });
    expect(err).toBe('unauthorized');
    socket.disconnect();

    // Réactive explicitement (aucune réactivation implicite ailleurs).
    const reactivate = await patchMember(
      ownerAToken,
      targetSellerMembershipId,
      { status: 'active' },
    );
    expect(reactivate.status).toBe(200);
  });

  it('9. socket déjà connectée est déconnectée APRÈS le commit d’une mutation membership', async () => {
    const socket = connectSocket(targetSellerToken);
    await waitForEvent(socket, 'connect');
    expect(socket.connected).toBe(true);

    const disconnectPromise = waitForEvent(socket, 'disconnect');
    const patch = await patchMember(ownerAToken, targetSellerMembershipId, {
      permissions: ['analytics.read'],
    });
    expect(patch.status).toBe(200);
    await disconnectPromise;
    expect(socket.connected).toBe(false);

    // Restaure et referme proprement.
    await patchMember(ownerAToken, targetSellerMembershipId, {
      permissions: [],
    });
  });

  it('10. rollback (refus anti-escalade) : aucune mutation, socket cible TOUJOURS connectée', async () => {
    const socket = connectSocket(targetSellerToken);
    await waitForEvent(socket, 'connect');

    const before = await membershipModel
      .findById(targetSellerMembershipId)
      .lean()
      .exec();

    const refused = await patchMember(
      delegatedSellerToken,
      targetSellerMembershipId,
      { permissions: ['members.invite'] }, // hors des droits du délégué
    );
    expect(refused.status).toBe(403);

    const after = await membershipModel
      .findById(targetSellerMembershipId)
      .lean()
      .exec();
    expect(after!.permissions).toEqual(before!.permissions);
    expect(after!.status).toBe(before!.status);
    // Aucun disconnect : le refus précède toute écriture (jamais de commit).
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(socket.connected).toBe(true);
    socket.disconnect();
  });

  it('11. transfert atomique : ancien owner → admin/active, cible → owner/active, exactement un owner', async () => {
    const before = await listMembers(ownerAToken);
    expect(
      (before.body as Array<{ role: string }>).filter(
        (m) => m.role === 'owner',
      ),
    ).toHaveLength(1);

    const res = await transferOwnership(
      ownerAToken,
      transferTargetMembershipId,
    );
    expect(res.status).toBe(200);
    expect(res.body.previousOwner.role).toBe('admin');
    expect(res.body.previousOwner.status).toBe('active');
    expect(res.body.newOwner.role).toBe('owner');
    expect(res.body.newOwner.status).toBe('active');

    const after = await listMembers(adminAToken); // adminA garde members.manage
    const owners = (after.body as Array<{ role: string }>).filter(
      (m) => m.role === 'owner',
    );
    expect(owners).toHaveLength(1);

    // 12. owner-only impossible à un admin (délégation complète), même l'EX-owner :
    const exOwnerToken = ownerAToken;
    const retryTransfer = await transferOwnership(
      exOwnerToken,
      adminAMembershipId,
    );
    expect(retryTransfer.status).toBe(403);
  });

  it('13. transfert concurrent (org D dédiée) : une seule réussite', async () => {
    const c1 = await createMember(
      orgDId,
      'Concurrent Target 1',
      'concurrent-1-17c@royalvibe.test',
      'seller',
    );
    const c2 = await createMember(
      orgDId,
      'Concurrent Target 2',
      'concurrent-2-17c@royalvibe.test',
      'seller',
    );

    const [r1, r2] = await Promise.all([
      transferOwnership(ownerDToken, c1.membershipId),
      transferOwnership(ownerDToken, c2.membershipId),
    ]);

    const statuses = [r1.status, r2.status];
    const successCount = statuses.filter((s) => s === 200).length;
    // Exactement une réussite (200) ; l'autre échoue (le second acteur n'est
    // plus owner dès que le premier a committé, ou conflit de transaction).
    expect(successCount).toBe(1);

    const membersD = await membershipModel
      .find({ organizationId: new Types.ObjectId(orgDId), role: 'owner' })
      .lean()
      .exec();
    expect(membersD).toHaveLength(1);
  });
});
