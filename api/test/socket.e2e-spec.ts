import 'reflect-metadata';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { Model } from 'mongoose';
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
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';

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
 *   - valide : tokens portés par `/auth/login` (payload `{ sub, email,
 *     role }` signés par l'`AuthService` réel) ;
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

describe('Socket.IO (e2e — authentification du handshake + contrôle des origines)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let ioServer: IoServer;
  let jwtService: JwtService;

  // Tokens de chaque scénario.
  let validSellerToken = '';
  let validAdminToken = '';
  let expiredToken = '';
  let forgedToken = '';
  let deletedUserToken = '';
  /** `sub` du seller (pour forger le token court du § 7). */
  let sellerSub = '';

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
      }).compile();
      app = moduleFixture.createNestApplication();
      jwtService = moduleFixture.get(JwtService);
      await app.init();
      await app.listen(0);
      port = (app.getHttpServer().address() as AddressInfo).port;
      ioServer = moduleFixture.get(EventsGateway).server;

      // ---- Fixtures : users + tokens par scénario ----
      const register = (name: string, email: string, password: string) =>
        request(app.getHttpServer())
          .post('/auth/register')
          .send({ name, email, password });
      const login = (email: string, password: string) =>
        request(app.getHttpServer())
          .post('/auth/login')
          .send({ email, password });

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
      const userModel = moduleFixture.get<Model<UserDocument>>(
        getModelToken('User'),
      );
      const adminDoc = await userModel.findOne({ email: ADMIN_EMAIL });
      expect(adminDoc).toBeTruthy();
      adminDoc!.role = UserRole.ADMIN;
      await adminDoc!.save();

      const adminLogin = await login(ADMIN_EMAIL, ADMIN_PW);
      expect(adminLogin.status).toBe(201);
      validAdminToken = adminLogin.body.access_token as string;

      const sellerLogin = await login(SELLER_EMAIL, SELLER_PW);
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
      const deletedLogin = await login(DELETED_EMAIL, DELETED_PW);
      expect(deletedLogin.status).toBe(201);
      deletedUserToken = deletedLogin.body.access_token as string;
      const deletedDoc = await userModel.findOne({ email: DELETED_EMAIL });
      expect(deletedDoc).toBeTruthy();
      await userModel.deleteOne({ _id: deletedDoc!._id });

      // Tokens forgés : payload identique à l'`AuthService.sign` (seule
      // différence : l'expiration / le secret) — pour isoler la variable.
      const payload = {
        sub: sellerSub,
        email: SELLER_EMAIL,
        role: UserRole.SELLER,
      };
      expiredToken = jwtService.sign(payload, { expiresIn: -10 });
      forgedToken = jwtService.sign(payload, {
        expiresIn: '1h',
        secret: WRONG_SECRET,
      });
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
      expect(sellerPayload.email).toBe(SELLER_EMAIL);
      expect(sellerPayload.role).toBe(UserRole.SELLER);
      const adminPayload = jwtService.verify(validAdminToken);
      expect(adminPayload.email).toBe(ADMIN_EMAIL);
      expect(adminPayload.role).toBe(UserRole.ADMIN);
    });

    it('0.4 les tokens forgés (expiré / falsifié) portent { sub, email, role }', () => {
      const expiredPayload = jwtService.decode(expiredToken);
      expect(expiredPayload.sub).toBeTruthy();
      expect(expiredPayload.email).toBe(SELLER_EMAIL);
      expect(expiredPayload.role).toBe(UserRole.SELLER);
      const forgedPayload = jwtService.decode(forgedToken);
      expect(forgedPayload.sub).toBeTruthy();
      expect(forgedPayload.email).toBe(SELLER_EMAIL);
      expect(forgedPayload.role).toBe(UserRole.SELLER);
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
        {
          sub: sellerSub,
          email: SELLER_EMAIL,
          role: UserRole.SELLER,
        },
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
});
