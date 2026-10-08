import 'reflect-metadata';
import * as http from 'http';
import { randomBytes } from 'crypto';
import type { AddressInfo } from 'net';
import { Model, Types } from 'mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { io } from 'socket.io-client';
import { App } from 'supertest/types';
import type { ManagerOptions, Socket } from 'socket.io-client';
import type { Server as IoServer } from 'socket.io';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { EventsGateway } from './../src/events/events.gateway';
import { UserDocument, UserRole } from './../src/users/schemas/user.schema';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import { ProductDocument } from './../src/products/schemas/product.schema';
import { SectionDocument } from './../src/sections/schemas/section.schema';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import { activateTestSubscriptions } from './e2e/subscription-fixtures';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import {
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';
import { OWNER_TERMS } from './e2e/legal-acceptance-fixtures';

// 1-13A : expéditeur simulé, liens confirmés via le service réel.
const emailSender = createE2eEmailSender();

/**
 * E2E — phase 0B.3 : authentification du handshake Socket.IO + contrôle des
 * origines, sur une application NestJS RÉELLE + un vrai `socket.io-client`.
 *
 * Cycle de vie identique à `app.e2e-spec.ts` : MongoDB éphémère
 * (MongoMemoryReplSet) démarrée dans `beforeAll` / arrêtée dans `afterAll`
 * via le singleton `ephemeral-mongodb` ; `AppModule` complet compilé,
 * `app.init()` puis `app.listen(0)` (port éphémère) ; le serveur Socket.IO
 * est **attaché** au même HTTP serveur (Nest + `port === 0` + `httpServer`
 * partagés → `new Server(httpServer, options)`).
 *
 * Le middleware `auth` est installé par `afterInit` pendant `app.init()`
 * (avant `listen`) — donc en place avant toute connexion client.
 *
 * **Transport : WebSocket.** `transports: ['websocket']` — les assertions
 * portent sur le handshake WebSocket réel. Le verrou d'origine est
 * `allowRequest` (engine.io), lu par `Server#verify` pour **chaque**
 * handshake ET **upgrade de transport** (c'est le `cors` seul qui ne porte
 * que le long-polling). L'en-tête `Origin` côté client est posé via
 * `extraHeaders` (engine.io-client node : `opts.headers = extraHeaders` sur
 * l'upgrade `ws`).
 *
 * **Tokens** (MÊME `JwtService` que l'auth HTTP — secret statique de test
 * `TEST_JWT_SECRET`, jamais un secret réel) :
 *   - valide : tokens portés par `/auth/login` (payload `{ sub, orgId }`
 *     signés par l'`AuthService` réel) ;
 *   - court : `jwtService.sign(payload, { expiresIn: 6 })` signé JUSTE
 *     avant le test (margin d'expiration vs handshake) — §7 ;
 *   - expiré : `jwtService.sign(payload, { expiresIn: -10 })`
 *     (secret correct, `exp` dépassé) ;
 *   - falsifié : `jwtService.sign(payload, { secret: WRONG_SECRET })`
 *     (secret incorrect → signature invalide).
 *
 * **Comportements attendus** :
 * - sans token / expiré / falsifié / user supprimé → client `connect_error`
 *   `err.message === 'unauthorized'` (générique UNIFIÉ) ; **aucun socket de
 *   namespace créé** (`ioServer.sockets.sockets.size` inchangé) ;
 * - origine non autorisée → refus `allowRequest` au NIVEAU TRANSPORT
 *   (jamais de `connect_error 'unauthorized'` — message de l'`Origin`, pas
 *   du middleware JWT) ; aucun socket de namespace ;
 * - origine autorisée + token valide → `connect` ;
 * - long-polling : réflexion `Access-Control-Allow-Origin` via le délégué
 *   `@WebSocketGateway` `cors.origin` ;
 * - token court (`expiresIn: 6`) → `connect` puis **déconnexion FORCÉE par
 *   le SERVEUR à `exp`** (timer du middleware `scheduleSocketDisconnectAtExpiry`)
 *   : le client reçoit `disconnect` (`io server disconnect`) et le compteur
 *   de sockets revient à la base (§ 7).
 *
 * **Environnement** : `NODE_ENV=test`. En dev/test, l'absence d'`Origin`
 * est tolérée (documenté) ; en production, elle est refusée + `CORS_ORIGIN`
 * obligatoire (couvert en unitaire — `events.gateway.spec.ts`).
 *
 * Aucun skip / todo / only.
 */

const TEST_JWT_SECRET = 'socket-e2e-only-not-production';
const WRONG_SECRET = 'e2e-wrong-secret-not-the-one-configured';
const ALLOWED_ORIGIN = 'https://royalvibe-cosmetic.vercel.app';
const DISALLOWED_ORIGIN = 'https://attacker.example.com';
const ADMIN_EMAIL = 'admin-socket-e2e@royalvibe.test';
const SELLER_EMAIL = 'seller-socket-e2e@royalvibe.test';
const DELETED_EMAIL = 'deleted-socket-e2e@royalvibe.test';
const ADMIN_PW = 'admin-e2e-pw-!1x';
const SELLER_PW = 'seller-e2e-pw-!1x';
const DELETED_PW = 'deleted-e2e-pw-!1x';
// 1-3B.1 : une organisation active partage (fixtures) — sans elle, le
// login renvoie 403 ORGANIZATION_ACCESS_DENIED. Fixtures générales, sans
// données RoyalVibe.
const SOCKET_ORG_ID = 'cccccccccccccccccccccccc';
const SOCKET_ORG_B_ID = 'dddddddddddddddddddddddd';

/** Port éphémère réel de l'HTTP serveur (et du Socket.IO attaché). */
let port: number;

const SOCKET_OPTS: Partial<ManagerOptions> = {
  transports: ['websocket'],
  reconnection: false,
  timeout: 4_000,
};

/** Nombre de sockets connectés dans le namespace par défaut (`/`). */
function connectedSockets(ioSrv: IoServer): number {
  const nsp = ioSrv.sockets as unknown as {
    sockets: Map<string, unknown>;
  };
  return nsp.sockets.size;
}

function waitForSocketCount(
  ioSrv: IoServer,
  expected: number,
  timeoutMs = 4_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = (): void => {
      if (connectedSockets(ioSrv) === expected) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Socket count did not reach ${expected}`));
        return;
      }
      setImmediate(check);
    };
    check();
  });
}

describe('Socket.IO (e2e — authentification du handshake + contrôle des origines)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let ioServer: IoServer;
  let jwtService: JwtService;
  let userModel: Model<UserDocument>;
  let organizationModel: Model<OrganizationDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let productModel: Model<ProductDocument>;
  let sectionModel: Model<SectionDocument>;

  // Tokens de chaque scénario.
  let validSellerToken = '';
  let validAdminToken = '';
  let validAdminTokenB = '';
  let expiredToken = '';
  let forgedToken = '';
  let deletedUserToken = '';
  /** `sub` du seller (pour forger le token court du § 7). */
  let sellerSub = '';
  let adminSub = '';
  let productAId = '';
  let productBId = '';

  /** Clients ouverts (tous fermés en `afterAll`). */
  const openSockets: Socket[] = [];

  /** Connecte un client (WebSocket) avec `extraHeaders.origin` + `auth.token`. */
  function connect(
    origin: string | undefined,
    token: string | undefined,
  ): Socket {
    const socket = io(`http://127.0.0.1:${port}`, {
      ...SOCKET_OPTS,
      ...(origin !== undefined ? { extraHeaders: { origin } } : {}),
      ...(token !== undefined ? { auth: { token } } : {}),
    });
    openSockets.push(socket);
    return socket;
  }

  /**
   * Attend `connect`, `connect_error` ou `waitMs` (le premier à arriver).
   * Renvoie `{ connected, errMsg }` — `errMsg` = message du `connect_error`
   * (vide si jamais émis).
   */
  function expectAttempt(
    socket: Socket,
    waitMs = 8_000,
  ): Promise<{ connected: boolean; errMsg: string }> {
    return new Promise((resolve) => {
      let errMsg = '';
      let settled = false;
      const finish = (connected: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ connected, errMsg });
      };
      const timer = setTimeout(() => finish(socket.connected), waitMs);
      socket.once('connect', () => finish(true));
      socket.once('connect_error', (err: Error) => {
        errMsg = err?.message ?? '';
        finish(false);
      });
      socket.once('disconnect', () => finish(socket.connected));
    });
  }

  function closeSocket(socket: Socket): void {
    socket?.disconnect();
  }

  /**
   * Attend l'événement `disconnect` du client (déconnexion FORCÉE par le
   * serveur à `exp` — reason `io server disconnect`) ou `waitMs`.
   */
  function waitForDisconnect(
    socket: Socket,
    waitMs = 9_000,
  ): Promise<{ disconnected: boolean; reason: string }> {
    return new Promise((resolve) => {
      let reason = '';
      let settled = false;
      const finish = (disconnected: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ disconnected, reason });
      };
      const timer = setTimeout(
        () => finish(socket.connected === false),
        waitMs,
      );
      socket.once('disconnect', (r: string) => {
        reason = r ?? '';
        finish(true);
      });
    });
  }

  /** Petit délai pour laisser le serveur propager un disconnect. */
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** GET long-polling avec en-tête `Origin` explicite (node:http — fiable). */
  function pollingHandshake(
    origin: string | undefined,
  ): Promise<{ status: number; acacao: string | null }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/socket.io/?EIO=4&transport=polling',
          method: 'GET',
          headers: origin !== undefined ? { Origin: origin } : {},
        },
        (res) => {
          res.resume();
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              acacao:
                (res.headers['access-control-allow-origin'] as string) ?? null,
            }),
          );
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  /**
   * 1-12F — ouvre une session Engine.IO v4 en long-polling SANS token
   * (le JWT n'est vérifié qu'à la connexion du namespace, APRÈS ce handshake)
   * et renvoie son `sid`.
   */
  function openPollingSession(origin: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/socket.io/?EIO=4&transport=polling',
          method: 'GET',
          headers: { Origin: origin },
          timeout: 4_000,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () => {
            // Paquet OPEN Engine.IO v4 : `0{"sid":"…",…}`.
            const match = /^0(\{.*\})/.exec(body);
            if (res.statusCode !== 200 || !match) {
              reject(new Error(`Handshake polling refusé (${res.statusCode})`));
              return;
            }
            resolve((JSON.parse(match[1]) as { sid: string }).sid);
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('Handshake timeout')));
      req.on('error', reject);
      req.end();
    });
  }

  /**
   * 1-12F — tentative d'upgrade WebSocket BRUTE (node:http, aucune
   * dépendance) sur une session existante. Renvoie 101 si l'upgrade est
   * accepté (le socket est aussitôt détruit, aucun paquet envoyé), sinon le
   * statut HTTP du refus.
   */
  function rawWebSocketUpgrade(query: string, origin: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: `/socket.io/?${query}`,
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
          Origin: origin,
        },
        timeout: 4_000,
      });
      req.on('upgrade', (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 101);
      });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('timeout', () => req.destroy(new Error('Upgrade timeout')));
      req.on('error', reject);
      req.end();
    });
  }

  // ---------------------------------------------------------------------
  // Cycle de vie : mongo éphémère + appli + port + fixtures
  // ---------------------------------------------------------------------
  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      const uri = validatedEphemeralUri(replSet);
      // Env fixées AVANT compile (ConfigModule lit `process.env` au boot).
      process.env.MONGODB_URI = uri;
      process.env.JWT_SECRET = TEST_JWT_SECRET;
      process.env.CORS_ORIGIN = ALLOWED_ORIGIN;
      process.env.NODE_ENV = 'test';
      // 0B.5 : activé explicitement pour les fixtures (désactivé par défaut).
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
      // S3 : valeurs locales factices (aucun test 0B.3 n'appelle S3).
      process.env.S3_ENDPOINT = 'http://127.0.0.1:65535';
      process.env.S3_REGION = 'us-east-1';
      process.env.S3_ACCESS_KEY = 'e2e-local';
      process.env.S3_SECRET_KEY = 'e2e-local';
      process.env.S3_BUCKET = 'e2e-local';
      process.env.S3_FORCE_PATH_STYLE = 'true';

      moduleFixture = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(EMAIL_SENDER)
        .useValue(emailSender)
        .compile();
      app = moduleFixture.createNestApplication();
      jwtService = moduleFixture.get(JwtService);
      await app.init();
      autoConfirmVerificationEmails(app, emailSender);
      await app.listen(0);
      port = (app.getHttpServer().address() as AddressInfo).port;
      ioServer = moduleFixture.get(EventsGateway).server;

      // ---- Fixtures : users + tokens par scénario ----
      // 1-6A : /auth/register crée désormais AUSSI une organisation
      // propriétaire (organizationName obligatoire) — ces fixtures n'utilisent
      // QUE le User créé ; l'organisation auto-créée n'est jamais rejointe par
      // un login SANS organizationId dans ce fichier (tous les logins ci-dessous
      // fournissent un organizationId explicite), donc aucune interférence.
      const register = (name: string, email: string, password: string) =>
        request(app.getHttpServer())
          .post('/auth/register')
          .send({
            ...OWNER_TERMS,
            name,
            email,
            password,
            // 1-12D : noms d'organisation limités à 20 caractères.
            organizationName: `${name.slice(0, 16)} Org`,
          });
      const login = (
        email: string,
        password: string,
        organizationId?: string,
      ) =>
        request(app.getHttpServer())
          .post('/auth/login')
          .send(
            organizationId === undefined
              ? { email, password }
              : { email, password, organizationId },
          );

      const adminReg = await register(
        'Admin Socket E2E',
        ADMIN_EMAIL,
        ADMIN_PW,
      );
      expect(adminReg.status).toBe(201);
      const sellerReg = await register(
        'Seller Socket E2E',
        SELLER_EMAIL,
        SELLER_PW,
      );
      expect(sellerReg.status).toBe(201);

      // Élévation admin sur la base éphémère (périmètre : PAS de politique
      // d'inscription modifiée — écriture directe de test uniquement).
      userModel = moduleFixture.get<Model<UserDocument>>(getModelToken('User'));
      const adminDoc = await userModel.findOne({ email: ADMIN_EMAIL });
      expect(adminDoc).toBeTruthy();
      adminDoc!.role = UserRole.ADMIN;
      await adminDoc!.save();

      // ---- Fixtures organisation (1-3B.1) ----
      // Organisation unique : memberships actives pour chaque test user.
      // Un login sans `organizationId` auto-sélectionne cette org
      // (cas B du login).
      organizationModel = moduleFixture.get<Model<OrganizationDocument>>(
        getModelToken(Organization.name),
      );
      membershipModel = moduleFixture.get<
        Model<OrganizationMembershipDocument>
      >(getModelToken(OrganizationMembership.name));
      productModel = moduleFixture.get<Model<ProductDocument>>(
        getModelToken('Product'),
      );
      sectionModel = moduleFixture.get<Model<SectionDocument>>(
        getModelToken('Section'),
      );
      await organizationModel.create([
        {
          _id: new Types.ObjectId(SOCKET_ORG_ID),
          slug: 'socket-e2e-org',
          name: 'Socket E2E Org',
        },
        {
          _id: new Types.ObjectId(SOCKET_ORG_B_ID),
          slug: 'socket-e2e-org-b',
          name: 'Socket E2E Org B',
        },
      ]);
      // 1-14C.1 : accès métier → période active explicite.
      await activateTestSubscriptions(moduleFixture, [
        SOCKET_ORG_ID,
        SOCKET_ORG_B_ID,
      ]);
      // ADMIN + SELLER existent déjà (registrés plus haut). Le user DELETED
      // est enregistré PLUS BAS (scénario « supprimé ») : sa membership est
      // créée juste après son register (ci-dessous), jamais ici.
      // 1-7B : le rôle ORGANISATIONNEL (membership) décide désormais des
      // permissions métier — distinct du `User.role` LEGACY ci-dessus.
      for (const [email, membershipRole] of [
        [ADMIN_EMAIL, 'admin'],
        [SELLER_EMAIL, 'seller'],
      ] as const) {
        const u = await userModel.findOne({ email });
        if (!u) continue;
        await membershipModel.create({
          // `new Types.ObjectId` obligatoire : une chaîne hex brute n'est
          // PAS castée en ObjectId à l'écriture (fixtures E2E 1-3B.1).
          organizationId: new Types.ObjectId(SOCKET_ORG_ID),
          userId: u._id,
          role: membershipRole,
          status: 'active',
        });
      }

      const adminLogin = await login(ADMIN_EMAIL, ADMIN_PW, SOCKET_ORG_ID);
      expect(adminLogin.status).toBe(201);
      validAdminToken = adminLogin.body.access_token as string;
      adminSub = adminLogin.body.user._id as string;

      await membershipModel.create({
        organizationId: new Types.ObjectId(SOCKET_ORG_B_ID),
        userId: new Types.ObjectId(adminSub),
        role: 'owner',
        status: 'active',
      });
      const adminLoginB = await login(ADMIN_EMAIL, ADMIN_PW, SOCKET_ORG_B_ID);
      expect(adminLoginB.status).toBe(201);
      validAdminTokenB = adminLoginB.body.access_token as string;

      const sellerLogin = await login(SELLER_EMAIL, SELLER_PW, SOCKET_ORG_ID);
      expect(sellerLogin.status).toBe(201);
      validSellerToken = sellerLogin.body.access_token as string;
      sellerSub = sellerLogin.body.user._id as string;

      // « User supprimé » : register + token + deleteOne (base éphémère).
      const deletedReg = await register(
        'Deleted Socket E2E',
        DELETED_EMAIL,
        DELETED_PW,
      );
      expect(deletedReg.status).toBe(201);
      // Membership active AVANT login (sinon 403 ORGANIZATION_ACCESS_DENIED).
      const deletedDoc = await userModel.findOne({ email: DELETED_EMAIL });
      expect(deletedDoc).toBeTruthy();
      await membershipModel.create({
        organizationId: new Types.ObjectId(SOCKET_ORG_ID),
        userId: deletedDoc!._id,
        role: 'seller',
        status: 'active',
      });
      const deletedLogin = await login(
        DELETED_EMAIL,
        DELETED_PW,
        SOCKET_ORG_ID,
      );
      expect(deletedLogin.status).toBe(201);
      deletedUserToken = deletedLogin.body.access_token as string;
      await userModel.deleteOne({ _id: deletedDoc!._id });

      // Tokens forgés : payload identique à l'`AuthService.sign` (seule
      // différence : l'expiration / le secret) — pour isoler la variable.
      const payload = { sub: sellerSub, orgId: SOCKET_ORG_ID };
      expiredToken = jwtService.sign(payload, { expiresIn: -10 });
      forgedToken = jwtService.sign(payload, {
        expiresIn: '1h',
        secret: WRONG_SECRET,
      });

      const sections = await sectionModel.create([
        {
          organizationId: new Types.ObjectId(SOCKET_ORG_ID),
          name: 'Socket Section A',
          description: '',
          deletedAt: null,
          parentId: null,
        },
        {
          organizationId: new Types.ObjectId(SOCKET_ORG_B_ID),
          name: 'Socket Section B',
          description: '',
          deletedAt: null,
          parentId: null,
        },
      ]);
      const products = await productModel.create([
        {
          organizationId: new Types.ObjectId(SOCKET_ORG_ID),
          sectionId: sections[0]._id,
          name: 'Socket Product A',
          imageUrl: 'https://e2e.local/a.png',
          purchasePrice: 10,
          salePrice: 20,
          initialQuantity: 5,
          remainingQuantity: 5,
        },
        {
          organizationId: new Types.ObjectId(SOCKET_ORG_B_ID),
          sectionId: sections[1]._id,
          name: 'Socket Product B',
          imageUrl: 'https://e2e.local/b.png',
          purchasePrice: 10,
          salePrice: 20,
          initialQuantity: 5,
          remainingQuantity: 5,
        },
      ]);
      productAId = products[0]._id.toString();
      productBId = products[1]._id.toString();
    } catch (err) {
      if (moduleFixture) await moduleFixture.close().catch(() => undefined);
      if (app) await app.close().catch(() => undefined);
      await stopEphemeralMongoSafe();
      throw err;
    }
  }, 180_000);

  afterAll(async () => {
    // Ordre strict : fermer TOUS les clients Socket.IO (pas de handle
    // laissé ouvert), puis Nest (connexion Mongoose + socket.io attaché),
    // puis le mongod éphémère. Même après un échec.
    await settle(50);
    for (const s of openSockets) closeSocket(s);
    openSockets.length = 0;
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 120_000);

  // ---------------------------------------------------------------------
  // 0. Infrastructure
  // ---------------------------------------------------------------------
  describe('0. Infrastructure', () => {
    it('0.1 le serveur Socket.IO est attaché au même HTTP serveur que l’application', () => {
      expect(ioServer).toBeDefined();
      expect((ioServer as unknown as { httpServer?: unknown }).httpServer).toBe(
        app.getHttpServer(),
      );
    });

    it('0.2 aucun socket connecté au boot (base éphémère, serveur neuf)', () => {
      expect(connectedSockets(ioServer)).toBe(0);
    });

    it('0.3 les tokens portés sont valides (admin et seller, secret réel)', () => {
      expect(validSellerToken).toBeTruthy();
      expect(validAdminToken).toBeTruthy();
      const sellerPayload = jwtService.verify(validSellerToken);
      expect(String(sellerPayload.orgId)).toBe(SOCKET_ORG_ID);
      const adminPayload = jwtService.verify(validAdminToken);
      expect(String(adminPayload.orgId)).toBe(SOCKET_ORG_ID);
    });

    it('0.4 les tokens forgés (expiré / falsifié) portent { sub, orgId }', () => {
      const expiredPayload = jwtService.decode(expiredToken);
      expect(expiredPayload.sub).toBeTruthy();
      expect(String(expiredPayload.orgId)).toBe(SOCKET_ORG_ID);
      const forgedPayload = jwtService.decode(forgedToken);
      expect(forgedPayload.sub).toBeTruthy();
      expect(String(forgedPayload.orgId)).toBe(SOCKET_ORG_ID);
    });
  });

  // ---------------------------------------------------------------------
  // 1. Refus JWT (WebSocket — `connect_error unauthorized`, aucun socket)
  // ---------------------------------------------------------------------
  describe('1. Refus JWT (WebSocket — `connect_error unauthorized`, aucun socket créé)', () => {
    it('1.1 sans token → connect_error « unauthorized » ; aucun socket de namespace', async () => {
      const before = connectedSockets(ioServer);
      const socket = connect(ALLOWED_ORIGIN, undefined);
      const { connected, errMsg } = await expectAttempt(socket);
      expect(connected).toBe(false);
      expect(socket.connected).toBe(false);
      expect(errMsg).toBe('unauthorized');
      expect(connectedSockets(ioServer)).toBe(before);
      closeSocket(socket);
      await settle(100);
      expect(connectedSockets(ioServer)).toBe(before);
    });

    it('1.2 JWT falsifié (autre secret) → « unauthorized » ; aucun socket', async () => {
      const before = connectedSockets(ioServer);
      const socket = connect(ALLOWED_ORIGIN, forgedToken);
      const { connected, errMsg } = await expectAttempt(socket);
      expect(connected).toBe(false);
      expect(socket.connected).toBe(false);
      expect(errMsg).toBe('unauthorized');
      expect(connectedSockets(ioServer)).toBe(before);
      closeSocket(socket);
      await settle(100);
      expect(connectedSockets(ioServer)).toBe(before);
    });

    it('1.3 JWT expiré (secret correct, `exp` dépassé) → « unauthorized » ; aucun socket', async () => {
      const before = connectedSockets(ioServer);
      const socket = connect(ALLOWED_ORIGIN, expiredToken);
      const { connected, errMsg } = await expectAttempt(socket);
      expect(connected).toBe(false);
      expect(socket.connected).toBe(false);
      expect(errMsg).toBe('unauthorized');
      expect(connectedSockets(ioServer)).toBe(before);
      closeSocket(socket);
      await settle(100);
      expect(connectedSockets(ioServer)).toBe(before);
    });

    it('1.4 user supprimé (JWT valide) → « unauthorized » ; aucun socket', async () => {
      const before = connectedSockets(ioServer);
      const socket = connect(ALLOWED_ORIGIN, deletedUserToken);
      const { connected, errMsg } = await expectAttempt(socket);
      expect(connected).toBe(false);
      expect(socket.connected).toBe(false);
      expect(errMsg).toBe('unauthorized');
      expect(connectedSockets(ioServer)).toBe(before);
      closeSocket(socket);
      await settle(100);
      expect(connectedSockets(ioServer)).toBe(before);
    });
  });

  // ---------------------------------------------------------------------
  // 2. Valide (WebSocket — `connect`)
  // ---------------------------------------------------------------------
  describe('2. Valide (WebSocket — `connect`)', () => {
    it('2.1 seller valide + origine autorisée → connect, exactement +1 socket', async () => {
      const before = connectedSockets(ioServer);
      const socket = connect(ALLOWED_ORIGIN, validSellerToken);
      const { connected } = await expectAttempt(socket);
      expect(connected).toBe(true);
      expect(socket.connected).toBe(true);
      expect(connectedSockets(ioServer)).toBe(before + 1);
      closeSocket(socket);
      await settle(100);
      expect(connectedSockets(ioServer)).toBe(before);
    });

    it('2.2 admin valide + origine autorisée → connect, exactement +1 socket', async () => {
      const before = connectedSockets(ioServer);
      const socket = connect(ALLOWED_ORIGIN, validAdminToken);
      const { connected } = await expectAttempt(socket);
      expect(connected).toBe(true);
      expect(socket.connected).toBe(true);
      expect(connectedSockets(ioServer)).toBe(before + 1);
      closeSocket(socket);
      await settle(100);
      expect(connectedSockets(ioServer)).toBe(before);
    });
  });

  // ---------------------------------------------------------------------
  // 3. Contrôle des origines (WebSocket — `allowRequest`)
  // ---------------------------------------------------------------------
  describe('3. Contrôle origines (WebSocket — `allowRequest`)', () => {
    it('3.1 origine non autorisée + JWT valide → aucun `connect`, ni `connect_error unauthorized`', async () => {
      const before = connectedSockets(ioServer);
      const socket = connect(DISALLOWED_ORIGIN, validSellerToken);
      const { connected, errMsg } = await expectAttempt(socket);
      // Le refus d'origine est au NIVEAU TRANSPORT (allowRequest) —
      // AVANT le middleware Socket.IO : le client ne reçoit PAS
      // `connect_error unauthorized` (message du middleware JWT).
      expect(connected).toBe(false);
      expect(socket.connected).toBe(false);
      expect(errMsg).not.toBe('unauthorized');
      expect(connectedSockets(ioServer)).toBe(before);
      closeSocket(socket);
      await settle(100);
      expect(connectedSockets(ioServer)).toBe(before);
    });

    it('3.2 origine autorisée + JWT valide → connect (couplage origine + auth)', async () => {
      const before = connectedSockets(ioServer);
      const socket = connect(ALLOWED_ORIGIN, validSellerToken);
      const { connected } = await expectAttempt(socket);
      expect(connected).toBe(true);
      expect(socket.connected).toBe(true);
      expect(connectedSockets(ioServer)).toBe(before + 1);
      closeSocket(socket);
      await settle(100);
      expect(connectedSockets(ioServer)).toBe(before);
    });
  });

  // ---------------------------------------------------------------------
  // 4. `Origin` absent — comportement dev/test toléré (documenté 0B.3)
  // ---------------------------------------------------------------------
  describe('4. `Origin` absent (dev/test toléré — prod refusé, unitaires)', () => {
    it('4.1 `Origin` absent + token valide → connect en `NODE_ENV=test`', async () => {
      const before = connectedSockets(ioServer);
      const socket = connect(undefined, validSellerToken);
      const { connected } = await expectAttempt(socket);
      // En dev/test, `createAllowRequest` tolère l'absence d'`Origin`.
      // Le refus en production + la garde `CORS_ORIGIN` obligatoire sont
      // couverts en unitaire (events.gateway.spec.ts).
      expect(connected).toBe(true);
      expect(socket.connected).toBe(true);
      expect(connectedSockets(ioServer)).toBe(before + 1);
      closeSocket(socket);
      await settle(100);
      expect(connectedSockets(ioServer)).toBe(before);
    });
  });

  // ---------------------------------------------------------------------
  // 5. `CORS_ORIGIN` relu à la volée (pas de valeur figée au boot)
  // ---------------------------------------------------------------------
  describe('5. `CORS_ORIGIN` relu à la volée (pas de valeur figée au boot)', () => {
    it('5.1 changer `CORS_ORIGIN` entre deux requêtes modifie le comportement', async () => {
      const prev = process.env.CORS_ORIGIN;
      const NEW_ORIGIN = 'https://alt-allowed.example.com';
      try {
        process.env.CORS_ORIGIN = NEW_ORIGIN;
        // L'origine ANCIENNEMENT autorisée n'est plus autorisée :
        const s1 = connect(ALLOWED_ORIGIN, validSellerToken);
        const r1 = await expectAttempt(s1);
        expect(r1.connected).toBe(false);
        closeSocket(s1);
        // L'origine NOUVELLEMENT autorisée est acceptée :
        const s2 = connect(NEW_ORIGIN, validSellerToken);
        const r2 = await expectAttempt(s2);
        expect(r2.connected).toBe(true);
        closeSocket(s2);
        await settle(100);
      } finally {
        process.env.CORS_ORIGIN = prev;
      }
    });
  });

  // ---------------------------------------------------------------------
  // 6. Réflexion `cors.origin` en long-polling (package `cors`)
  // ---------------------------------------------------------------------
  describe('6. Réflexion `cors.origin` en long-polling (`Access-Control-Allow-Origin`)', () => {
    it('6.1 origine autorisée → `Access-Control-Allow-Origin` réfléchi (200)', async () => {
      const { status, acacao } = await pollingHandshake(ALLOWED_ORIGIN);
      expect(status).toBe(200);
      expect(acacao).toBe(ALLOWED_ORIGIN);
    });

    it('6.2 origine non autorisée → aucun `Access-Control-Allow-Origin` (403)', async () => {
      const { status, acacao } = await pollingHandshake(DISALLOWED_ORIGIN);
      expect(status).toBe(403);
      expect(acacao).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // 7. Déconnexion à l'expiration du JWT (timer du middleware)
  // ---------------------------------------------------------------------
  describe('7. Déconnexion à l’expiration du JWT (socket Forcément fermé à exp)', () => {
    it('7.1 token court (expiresIn 6 s) → connect puis déconnexion SERVEUR à exp, compteur de retour à la base', async () => {
      const before = connectedSockets(ioServer);

      // Token signé JUSTE avant le handshake : fenêtre d'expiration ~6 s —
      // le timer du middleware (exp du payload vérifié) doit forcer la
      // déconnexion bien avant le fallback 9 s du helper.
      const shortLivedToken = jwtService.sign(
        { sub: sellerSub, orgId: SOCKET_ORG_ID },
        { expiresIn: 6 },
      );

      const socket = connect(ALLOWED_ORIGIN, shortLivedToken);
      const attempt = await expectAttempt(socket);
      expect(attempt.connected).toBe(true);
      expect(socket.connected).toBe(true);
      expect(connectedSockets(ioServer)).toBe(before + 1);

      // À l'échéance du token : le SERVEUR ferme le socket (`disconnect(true)`)
      // — le client reçoit `disconnect` avec le reason serveur.
      const { disconnected, reason } = await waitForDisconnect(socket);
      expect(disconnected).toBe(true);
      expect(reason).toBe('io server disconnect');
      expect(socket.connected).toBe(false);

      // Le socket a quitté le namespace (retour au compteur de base).
      await settle(100);
      expect(connectedSockets(ioServer)).toBe(before);
    });
  });

  describe('8. Rooms organisationnelles', () => {
    it('8.1 mutations A/B reçues uniquement par la socket de leur organisation', async () => {
      const socketA = connect(ALLOWED_ORIGIN, validAdminToken);
      const socketB = connect(ALLOWED_ORIGIN, validAdminTokenB);
      expect((await expectAttempt(socketA)).connected).toBe(true);
      expect((await expectAttempt(socketB)).connected).toBe(true);

      const receivedA: string[] = [];
      const receivedB: string[] = [];
      socketA.on('product:updated', (payload: { product: { name: string } }) =>
        receivedA.push(payload.product.name),
      );
      socketB.on('product:updated', (payload: { product: { name: string } }) =>
        receivedB.push(payload.product.name),
      );

      const eventA = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('product:updated A not received')),
          4_000,
        );
        socketA.once('product:updated', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      const updateA = await request(app.getHttpServer())
        .patch(`/products/${productAId}`)
        .set('Authorization', `Bearer ${validAdminToken}`)
        .send({ name: 'Socket Product A Updated' });
      expect(updateA.status).toBe(200);
      await eventA;

      const eventB = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('product:updated B not received')),
          4_000,
        );
        socketB.once('product:updated', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      const updateB = await request(app.getHttpServer())
        .patch(`/products/${productBId}`)
        .set('Authorization', `Bearer ${validAdminTokenB}`)
        .send({ name: 'Socket Product B Updated' });
      expect(updateB.status).toBe(200);
      await eventB;

      expect(receivedA).toEqual(['Socket Product A Updated']);
      expect(receivedB).toEqual(['Socket Product B Updated']);
      closeSocket(socketA);
      closeSocket(socketB);
      await waitForSocketCount(ioServer, 0);
    });

    it.each([
      ['membership suspendue', 'membership', 'suspended'],
      ['membership révoquée', 'membership', 'revoked'],
      ['organisation suspendue', 'organization', 'suspended'],
    ] as const)(
      '8.2 %s → connect_error unauthorized, aucune socket',
      async (_label, target, status) => {
        const before = connectedSockets(ioServer);
        try {
          if (target === 'membership') {
            await membershipModel.updateOne(
              {
                userId: new Types.ObjectId(adminSub),
                organizationId: new Types.ObjectId(SOCKET_ORG_B_ID),
              },
              { $set: { status } },
            );
          } else {
            await organizationModel.updateOne(
              { _id: new Types.ObjectId(SOCKET_ORG_B_ID) },
              { $set: { status } },
            );
          }

          const socket = connect(ALLOWED_ORIGIN, validAdminTokenB);
          const attempt = await expectAttempt(socket);
          expect(attempt.connected).toBe(false);
          expect(attempt.errMsg).toBe('unauthorized');
          expect(connectedSockets(ioServer)).toBe(before);
          closeSocket(socket);
        } finally {
          if (target === 'membership') {
            await membershipModel.updateOne(
              {
                userId: new Types.ObjectId(adminSub),
                organizationId: new Types.ObjectId(SOCKET_ORG_B_ID),
              },
              { $set: { status: 'active' } },
            );
          } else {
            await organizationModel.updateOne(
              { _id: new Types.ObjectId(SOCKET_ORG_B_ID) },
              { $set: { status: 'active' } },
            );
          }
        }
      },
    );
  });

  // ---------------------------------------------------------------------
  // 9. 1-12F — GHSA-2gc4-cqfq-p2gv : révision de protocole Engine.IO
  // ---------------------------------------------------------------------
  // Le handshake Engine.IO précède l'authentification du namespace : un
  // client SANS token peut ouvrir une session puis tenter un upgrade. Avant
  // engine.io 6.6.10, un upgrade avec un `EIO` différent (ou absent,
  // interprété comme v3) était accepté (101), ce qui permettait ensuite de
  // faire planter le processus par un heartbeat forgé. Aucun heartbeat n'est
  // envoyé ici : seul le refus de l'upgrade est vérifié.
  describe('9. Upgrade Engine.IO avec révision de protocole incohérente', () => {
    it('9.1 contrôle : upgrade avec le même EIO=4 → accepté (101)', async () => {
      const sid = await openPollingSession(ALLOWED_ORIGIN);
      const status = await rawWebSocketUpgrade(
        `EIO=4&transport=websocket&sid=${encodeURIComponent(sid)}`,
        ALLOWED_ORIGIN,
      );
      expect(status).toBe(101);
    });

    it.each([
      ['EIO=3 (différent de la session v4)', 'EIO=3&'],
      ['EIO absent (interprété comme v3)', ''],
    ])('9.2 upgrade %s → refus 400, aucun crash', async (_label, eio) => {
      const sid = await openPollingSession(ALLOWED_ORIGIN);
      const status = await rawWebSocketUpgrade(
        `${eio}transport=websocket&sid=${encodeURIComponent(sid)}`,
        ALLOWED_ORIGIN,
      );
      expect(status).toBe(400);
    });

    it('9.3 après les refus : serveur disponible et connexion légitime polling → websocket', async () => {
      const health = await request(app.getHttpServer()).get('/health');
      expect(health.status).toBe(200);

      // Transports par défaut du serveur (polling puis upgrade websocket).
      const socket = io(`http://127.0.0.1:${port}`, {
        transports: ['polling', 'websocket'],
        reconnection: false,
        timeout: 4_000,
        extraHeaders: { origin: ALLOWED_ORIGIN },
        auth: { token: validSellerToken },
      });
      openSockets.push(socket);
      expect((await expectAttempt(socket)).connected).toBe(true);

      const deadline = Date.now() + 4_000;
      while (
        socket.io.engine.transport.name !== 'websocket' &&
        Date.now() < deadline
      ) {
        await settle(20);
      }
      expect(socket.io.engine.transport.name).toBe('websocket');
      closeSocket(socket);
      await waitForSocketCount(ioServer, 0);
    });

    it('9.4 reconnexion avec le token courant (comme le client web) : ancien refusé, courant accepté', async () => {
      const first = connect(ALLOWED_ORIGIN, validSellerToken);
      expect((await expectAttempt(first)).connected).toBe(true);
      closeSocket(first);
      await waitForSocketCount(ioServer, 0);

      // Un token devenu invalide ne permet pas de se reconnecter…
      const stale = connect(ALLOWED_ORIGIN, expiredToken);
      const staleAttempt = await expectAttempt(stale);
      expect(staleAttempt.connected).toBe(false);
      expect(staleAttempt.errMsg).toBe('unauthorized');
      closeSocket(stale);

      // …le nouveau socket porteur du token courant se connecte.
      const current = connect(ALLOWED_ORIGIN, validSellerToken);
      expect((await expectAttempt(current)).connected).toBe(true);
      closeSocket(current);
      await waitForSocketCount(ioServer, 0);
    });
  });
});
