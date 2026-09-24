import 'reflect-metadata';
import { Connection, Model, Types } from 'mongoose';
import { JwtService } from '@nestjs/jwt';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument, UserRole } from './../src/users/schemas/user.schema';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import {
  MembershipStatus,
  OrganizationStatus,
} from './../src/organizations/permissions';
import {
  E2E_DB_NAME,
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import {
  OriginConfigError,
  buildHttpCorsOptions,
  buildOriginAllowlist,
  parseCORSOrigin,
} from './../src/events/origin.helpers';
import { ThrottlerStorage } from '@nestjs/throttler';
import { AUTH_RATE_LIMIT_CODE } from './../src/common/auth-rate-limiting';

/**
 * E2E (phase 0B.2) — application NestJS complète sur MongoDB éphémère.
 *
 * Stratégie de cycle de vie (documentée dans
 * docs/testing/phase-0b2-isolated-e2e.md) : le replica set est démarré dans
 * beforeAll et arrêté dans afterAll via try/catch — la seule façon de
 * partager l'instance avec l'AppModule initialisé par la MÊME suite.
 * globalSetup/globalTeardown partagent PAS leur contexte mémoire avec les
 * fichiers de test (Jest). L'exécution est séquentielle (maxWorkers=1).
 *
 * SÉCURITÉ — l'URI transmise à ConfigModule/Mongoose :
 *   1. provient UNIQUEMENT de l'instance MongoMemoryReplSet créée ici
 *      (validatedEphemeralUri = replSet.getUri(E2E_DB_NAME)) ;
 *   2. est VALIDÉE par la garde avant toute utilisation : refus de 27017,
 *      refus d'hôte distant, refus de toute base autre qu'inventory_saas_e2e ;
 *   3. api/.env n'est jamais lu pour décider de quoi que ce soit.
 * Le secret JWT est statique, réservé aux tests (ci-dessous) ; aucun secret
 * réel n'est utilisé et aucun secret n'est journalisé.
 *
 * NOTE (accès aux données) : @nestjs/mongoose utilise sa PROPRE connexion
 * (pas la connexion globale de `mongoose`) — c'est pourquoi les fixtures et
 * les assertions d'isolation passent par le conteneur Nest
 * (getModelToken/getConnectionToken) et non par `mongoose.model` global.
 */

const TEST_JWT_SECRET = 'e2e-only-static-secret-not-production-use';
const ADMIN_EMAIL = 'admin-e2e@royalvibe.test';
const SELLER_EMAIL = 'seller-e2e@royalvibe.test';
const ISO_EMAIL = 'isolation-e2e@royalvibe.test';
const EXISTING_SALE_ID_MISSING = '112233445566778899001122';
// Origine E2E autorisée (pas le fallback dev : le test doit prouver que la
// valeur parsée est bien celle servie en Access-Control-Allow-Origin).
const E2E_CORS_ORIGIN = 'https://e2e.example.com';

// 1-3B.1 : fixtures organisations + memberships (base de test générique,
// sans référence RoyalVibe).
const ORG_A_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ORG_B_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
// 1-3B.2 : organisation FALSIFIÉE (valeur fournie par le client) — la garde
// ne doit jamais l'utiliser (seul le claim signé du JWT compte).
const FORGED_ORG_ID = 'cc0000000000000000000000';
const MULTI_EMAIL = 'multi-e2e@royalvibe.test';
const MULTI_PW = 'multi-e2e-pw-!1x';

// Normalise le corps d'erreur (string ou string[]) pour des asserts lisibles.
// Le body de supertest est lâchement typé (any) : accepter `unknown` évite
// de propager cet `any` dans la signature (pas de no-unsafe-argument).
function messageOf(body: unknown): string {
  const m = (body as { message?: string | string[] } | undefined)?.message;
  return Array.isArray(m) ? m.join(' ') : String(m ?? '');
}

describe('App (e2e — MongoDB éphémère totalement isolée)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let adminToken = '';
  let sellerToken = '';
  let jwtService: JwtService;

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      // Garde d'isolation AVANT toute utilisation : si l'URI n'est pas celle
      // de l'instance éphémère, l'erreur est fatale et aucun test ne démarre.
      const uri = validatedEphemeralUri(replSet);
      process.env.MONGODB_URI = uri;
      process.env.JWT_SECRET = TEST_JWT_SECRET;
      // S3 : valeurs locales factices (aucun test de cette phase n'appelle
      // S3 ; S3Service construit son client sans réseau au bootstrap).
      process.env.S3_ENDPOINT = 'http://127.0.0.1:65535';
      process.env.S3_REGION = 'us-east-1';
      process.env.S3_ACCESS_KEY = 'e2e-local';
      process.env.S3_SECRET_KEY = 'e2e-local';
      process.env.S3_BUCKET = 'e2e-local';
      process.env.S3_FORCE_PATH_STYLE = 'true';
      // CORS strict (0B.4) : valeur parsée UNE FOIS par le parser strict de
      // 0B.3 — jamais de repli ouvert (`?? true`), comme dans main.ts.
      process.env.CORS_ORIGIN = E2E_CORS_ORIGIN;
      // 0B.5 : l'inscription publique est désactivée par défaut — les
      // fixtures existent UNIQUEMENT parce que la variable est activée
      // explicitement ICI (valeur exacte 'true') pour l'environnement de
      // test (lue par ConfigModule au boot de AppModule).
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';

      moduleFixture = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleFixture.createNestApplication();
      jwtService = moduleFixture.get(JwtService);
      // MÊME factory que main.ts (0B.4) : buildHttpCorsOptions — les E2E
      // prouvent donc le comportement EXACT de la production (origine
      // autorisée => écho exact ; absente/inconnue => SANS en-tête CORS et
      // SANS 500 ; méthodes/headers explicites ; pas de credentials).
      const corsAllowlist = buildOriginAllowlist(
        parseCORSOrigin(process.env.CORS_ORIGIN, 'development'),
      );
      app.enableCors(buildHttpCorsOptions(corsAllowlist));
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      app.useGlobalFilters(new HttpExceptionFilter());
      await app.init();

      // ---- Fixtures utilisateurs (base éphémère uniquement) ----
      const register = (name: string, email: string, password: string) =>
        request(app.getHttpServer())
          .post('/auth/register')
          .send({ name, email, password });
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
        'Admin E2E',
        ADMIN_EMAIL,
        'admin-e2e-pw-!1x',
      );
      expect(adminReg.status).toBe(201);

      const sellerReg = await register(
        'Seller E2E',
        SELLER_EMAIL,
        'seller-e2e-pw-!1x',
      );
      expect(sellerReg.status).toBe(201);

      // Le schéma donne le rôle seller par défaut et le périmètre interdit
      // toute modification de la logique d'inscription : l'admin de test est
      // donc élevé via la base éphémère UNIQUEMENT (écriture directe de test,
      // aucun changement de logique de production). Le modèle est lu via le
      // conteneur Nest (sa propre connexion Mongoose, pas la globale).
      const userModel = moduleFixture.get<Model<UserDocument>>(
        getModelToken('User'),
      );
      const adminDoc = await userModel.findOne({ email: ADMIN_EMAIL });
      expect(adminDoc).toBeTruthy();
      adminDoc!.role = UserRole.ADMIN;
      await adminDoc!.save();

      // ---- Fixtures organisations (1-3B.1) ----
      // Admin : membership actives sur les 2 orgs A et B (peut switch).
      // Seller : membership active sur A seulement (pas B → refus 403).
      // Multi : membership actives sur A et B (sélection requise multi-org).
      const organizationModel = moduleFixture.get<Model<OrganizationDocument>>(
        getModelToken(Organization.name),
      );
      const membershipModel = moduleFixture.get<
        Model<OrganizationMembershipDocument>
      >(getModelToken(OrganizationMembership.name));

      // Organisation A : `org-a` active, propriétaire admin.
      await organizationModel.create({
        _id: new Types.ObjectId(ORG_A_ID),
        slug: 'org-a',
        name: 'Org A',
      });
      // Organisation B : `org-b` active, propriétaire admin.
      await organizationModel.create({
        _id: new Types.ObjectId(ORG_B_ID),
        slug: 'org-b',
        name: 'Org B',
      });

      // Fixtures memberships : admin (owner) et seller (seller) + leurs
      // 2 orgs respectives. Le `userId` est le ObjectId de l'utilisateur.
      const adminUserId = adminDoc!._id.toString();
      const sellerUserDoc = await userModel.findOne({ email: SELLER_EMAIL });
      const sellerUserId = sellerUserDoc!._id.toString();

      await membershipModel.create({
        organizationId: new Types.ObjectId(ORG_A_ID),
        userId: new Types.ObjectId(adminUserId),
        role: 'owner',
        status: 'active',
      });
      await membershipModel.create({
        organizationId: new Types.ObjectId(ORG_B_ID),
        userId: new Types.ObjectId(adminUserId),
        role: 'owner',
        status: 'active',
      });
      await membershipModel.create({
        organizationId: new Types.ObjectId(ORG_A_ID),
        userId: new Types.ObjectId(sellerUserId),
        role: 'seller',
        status: 'active',
      });

      // ---- Utilisateur "multi" : 2 orgs → sélection requise ----
      const multiReg = await register('Multi E2E', MULTI_EMAIL, MULTI_PW);
      expect(multiReg.status).toBe(201);
      const multiUserDoc = await userModel.findOne({ email: MULTI_EMAIL });
      expect(multiUserDoc).toBeTruthy();
      await membershipModel.create({
        organizationId: new Types.ObjectId(ORG_A_ID),
        userId: multiUserDoc!._id,
        role: 'seller',
        status: 'active',
      });
      await membershipModel.create({
        organizationId: new Types.ObjectId(ORG_B_ID),
        userId: multiUserDoc!._id,
        role: 'seller',
        status: 'active',
      });

      // Admin a 2 orgs (A et B) : le login CHOISIT explicitement A
      // (cas C/D du login — le cas B auto-sélection est prouvé par le
      // login du seller, mono-org A, sans `organizationId`).
      const adminLogin = await login(ADMIN_EMAIL, 'admin-e2e-pw-!1x', ORG_A_ID);
      expect(adminLogin.status).toBe(201);
      adminToken = adminLogin.body.access_token as string;

      const sellerLogin = await login(SELLER_EMAIL, 'seller-e2e-pw-!1x');
      expect(sellerLogin.status).toBe(201);
      sellerToken = sellerLogin.body.access_token as string;
    } catch (err) {
      // Ne jamais laisser un mongod éphémère orphelin si le bootstrap échoue.
      if (moduleFixture) await moduleFixture.close().catch(() => undefined);
      await stopEphemeralMongoSafe();
      throw err;
    }
  }, 180_000);

  afterAll(async () => {
    // Fermeture garantie de NestJS (connexion Mongoose), puis arrêt du
    // mongod éphémère + suppression de ses données — même après échec.
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  describe('1. Démarrage', () => {
    it("l'application NestJS démarre sur la base éphémère et répond sur /health", () =>
      request(app.getHttpServer())
        .get('/health')
        .expect(200)
        .expect({ status: 'ok' }));
  });

  describe('2. Authentification', () => {
    it('une route protégée sans JWT retourne 401', () =>
      request(app.getHttpServer()).get('/analytics/overview').expect(401));

    it("une inscription de test écrit dans la base éphémère et n'expose pas le hash du mot de passe", async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Isolation E2E',
          email: ISO_EMAIL,
          password: 'iso-e2e-pw-!1x',
        });
      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe(ISO_EMAIL);
      expect(res.body.user.password).toBeUndefined();
    });

    it('la connexion avec les identifiants de test fonctionne et renvoie un token', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: SELLER_EMAIL, password: 'seller-e2e-pw-!1x' });
      expect(res.status).toBe(201);
      expect(typeof res.body.access_token).toBe('string');
      expect(res.body.user.email).toBe(SELLER_EMAIL);
    });
  });

  describe('3. Analytics : refus seller / accès admin (0B.1 revérifié E2E)', () => {
    it('un seller authentifié reçoit 403', () =>
      request(app.getHttpServer())
        .get('/analytics/overview')
        .set('Authorization', `Bearer ${sellerToken}`)
        .expect(403));

    it('un admin de test reçoit 200 avec les KPIs nuls (base éphémère vide)', async () => {
      const res = await request(app.getHttpServer())
        .get('/analytics/overview')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.totalRevenue).toBe(0);
      expect(res.body.productsCount).toBe(0);
      expect(res.body.totalInvested).toBe(0);
    });

    it.each([
      '/analytics/overview',
      '/analytics/products/ranking',
      '/analytics/sellers/ranking',
      '/analytics/monthly',
    ])('le seller est refusé avec 403 sur %s', async (endpoint) => {
      const res = await request(app.getHttpServer())
        .get(endpoint)
        .set('Authorization', `Bearer ${sellerToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('4. Validation (pipes & DTO de bout en bout)', () => {
    it('un identifiant Sales invalide retourne 400 (et non 500)', async () => {
      const res = await request(app.getHttpServer())
        .delete('/sales/not-an-object-id')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(400);
      expect(messageOf(res.body)).toContain('Invalid id');
    });

    it('un identifiant Sales valide mais inexistant ne retourne PAS 400 (le pipe laisse passer au service)', async () => {
      // id hex 24 caractères valide mais absent : le pipe DOIT le laisser
      // passer au service (404 métier), ne PAS rejeter en 400.
      const res = await request(app.getHttpServer())
        .delete(`/sales/${EXISTING_SALE_ID_MISSING}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).not.toBe(400);
      expect(res.status).not.toBe(500);
    });

    it("un nom de section composé uniquement d'espaces retourne 400", async () => {
      const res = await request(app.getHttpServer())
        .post('/sections')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: '   ', description: '' });
      expect(res.status).toBe(400);
      expect(messageOf(res.body)).toMatch(
        /must contain a non-whitespace character/i,
      );
    });
  });

  describe('5. Isolation (base éphémère, pas de fuite vers 27017)', () => {
    const connection = (): Connection =>
      moduleFixture.get<Connection>(getConnectionToken());

    it("la base Mongoose est bien la base éphémère nommée 'inventory_saas_e2e'", () => {
      expect(connection().getClient().db().databaseName).toBe(E2E_DB_NAME);
    });

    it('aucun serveur Mongoose connecté ne porte le port 27017 (tous sont 127.0.0.1)', () => {
      const servers = Array.from(
        connection().getClient().topology.description.servers.values(),
      );
      expect(servers.length).toBeGreaterThanOrEqual(1);
      for (const server of servers) {
        expect(server.address).toMatch(/^127\.0\.0\.1:/);
        expect(server.address).not.toContain(':27017');
      }
    });

    it('les données de test vivent dans la base éphémère (users ≥ 3, products vide)', async () => {
      const db = connection().getClient().db(E2E_DB_NAME);
      const userCount = await db.collection('users').countDocuments();
      const productCount = await db.collection('products').countDocuments();
      expect(userCount).toBeGreaterThanOrEqual(3);
      expect(productCount).toBe(0);
    });
  });

  describe('6. CORS HTTP strict (0B.4)', () => {
    // Le middleware CORS est reproduit AVANT app.init() comme dans main.ts :
    // cors@2.8.6, cb(null, true) => écho exacte de l'Origin demandée ;
    // cb(null, false/undefined) => la requête CONTINUE, SANS en-tête CORS —
    // jamais une 500 (exigence « origine refusée ≠ 500 »).

    it('une origine autorisée reçoit exactement SON Access-Control-Allow-Origin (pas *)', async () => {
      const res = await request(app.getHttpServer())
        .get('/health')
        .set('Origin', E2E_CORS_ORIGIN);
      expect(res.status).toBe(200);
      const acao = res.headers['access-control-allow-origin'];
      expect(acao).toBe(E2E_CORS_ORIGIN);
    });

    it('une origine inconnue n’obtient AUCUN en-tête CORS et la requête passe (pas de 500)', async () => {
      const res = await request(app.getHttpServer())
        .get('/health')
        .set('Origin', 'https://attacker.example.com');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('une requête SANS en-tête Origin reste autorisée (outils serveur, apps natives)', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('le preflight OPTIONS renvoie 204 avec les méthodes/headers autorisés et SANS credentials', async () => {
      const res = await request(app.getHttpServer())
        .options('/analytics/overview')
        .set('Origin', E2E_CORS_ORIGIN)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'authorization, content-type');
      expect(res.status).toBe(204);
      const acao = res.headers['access-control-allow-origin'];
      expect(acao).toBe(E2E_CORS_ORIGIN);
      const allowMethods = res.headers['access-control-allow-methods'];
      expect(allowMethods.split(',').map((m) => m.trim())).toEqual([
        'GET',
        'POST',
        'PUT',
        'PATCH',
        'DELETE',
        'OPTIONS',
      ]);
      const allowHeaders = res.headers['access-control-allow-headers'];
      expect(allowHeaders.toLowerCase()).toContain('content-type');
      expect(allowHeaders.toLowerCase()).toContain('authorization');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('en production sans CORS_ORIGIN, la garantie de lancement bloque le démarrage (OriginConfigError)', () => {
      // main.ts appelle parseCORSOrigin(process.env.CORS_ORIGIN,
      // 'production') avant NestFactory.create : l'exception interrompt
      // bootstrap, l'API ne démarre PAS (exigence n°1). La matrice
      // complète du parser est couverte par origin.helpers.spec.ts —
      // ici seule la garantie d'amorçage est prouvée.
      expect(() => parseCORSOrigin(undefined, 'production')).toThrow(
        OriginConfigError,
      );
      expect(() => parseCORSOrigin('   ', 'production')).toThrow(
        OriginConfigError,
      );
    });
  });

  describe('7. Inscription publique désactivée par défaut (0B.5)', () => {
    // Le garde lit `process.env` à CHAQUE requête (le guard est un export
    // pur, pas de valeur figée au boot) : on peut donc inverser
    // l'inscription à chaud, et le backend reste l'autorité finale même si
    // le frontend est mal configuré (ici aucune valeur n'est lue côté web).
    it('E2E : sans PUBLIC_REGISTRATION_ENABLED, POST /auth/register → 403 REGISTRATION_DISABLED, aucun compte créé', async () => {
      const usersCol = moduleFixture
        .get<Connection>(getConnectionToken())
        .getClient()
        .db(E2E_DB_NAME)
        .collection('users');
      const before = await usersCol.countDocuments();

      delete process.env.PUBLIC_REGISTRATION_ENABLED; // désactivée

      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          name: 'Refusé',
          email: 'refuse-0b5@royalvibe.test',
          password: 'secret-123',
        });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('REGISTRATION_DISABLED');

      // Aucun compte créé :
      const after = await usersCol.countDocuments();
      expect(after).toBe(before);

      // Et ce « compte » n'existe pas pour le login (jamais écrit) :
      const loginRes = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'refuse-0b5@royalvibe.test',
          password: 'secret-123',
        });
      expect(loginRes.status).toBe(401);
    });

    it('E2E : le login d’un compte EXISTANT (fixture) reste fonctionnel quand l’inscription est désactivée', async () => {
      delete process.env.PUBLIC_REGISTRATION_ENABLED; // désactivée
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: SELLER_EMAIL, password: 'seller-e2e-pw-!1x' });
      expect(res.status).toBe(201);
      expect(typeof res.body.access_token).toBe('string');
    });
  });

  describe('8. Rate limiting du login (0B.6)', () => {
    // Toutes les fenêtres s'appuient sur le stockage mémoire officiel de
    // `@nestjs/throttler` (0B.6) — correct pour UNE instance, pas distribué.
    // Le storage est isolé AVANT chaque test ; aucune suite antérieure ne
    // dépend de l'ordre d'exécution, et AUCUN test n'attend réellement 60 s
    // ou 15 min : le 429 est déclenché par dépassement de la limite (fenêtre
    // courte), pas par temporisation réelle.
    const clearThrottle = (): void => {
      // Méthode publique du stockage mémoire OFFICIEL de `@nestjs/throttler`
      // (vide les compteurs et les timers) — isolation entre les tests.
      const s = moduleFixture.get(ThrottlerStorage);
      s.onApplicationShutdown();
    };

    const wrongLogin = () =>
      request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: SELLER_EMAIL, password: 'wrong-password-x' });

    beforeEach(clearThrottle);

    it('un login valide fonctionne avant dépassement (compte dans la fenêtre)', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: SELLER_EMAIL, password: 'seller-e2e-pw-!1x' });
      expect(res.status).toBe(201);
      expect(typeof res.body.access_token).toBe('string');
    });

    it('les premières tentatives incorrectes conservent la réponse générique actuelle (401)', async () => {
      for (let i = 0; i < 3; i++) {
        const res = await wrongLogin();
        expect(res.status).toBe(401);
        expect(res.body.message).toContain('Email ou mot de passe incorrect');
        expect(res.body.code).toBeUndefined();
      }
    });

    it('la requête dépassant login-short (10/60 s) retourne 429', async () => {
      // 10 requêtes tolérées (401), la 11e déclenche le blocage de
      // login-short. La fenêtre login-long (30/15 min) n'est PAS atteinte.
      for (let i = 0; i < 10; i++) {
        const res = await wrongLogin();
        expect(res.status).toBe(401);
      }
      const last = await wrongLogin();
      expect(last.status).toBe(429);
    });

    it('le corps du 429 contient exactement AUTH_RATE_LIMITED (sans données d’auth)', async () => {
      let caught: undefined | { status: number; body: Record<string, unknown> };
      for (let i = 0; i < 11; i++) {
        const res = await wrongLogin();
        if (res.status === 429) {
          caught = res;
          break;
        }
      }
      expect(caught).toBeDefined();
      const body = (caught as { body: Record<string, unknown> }).body;
      expect(body.statusCode).toBe(429);
      expect(body.code).toBe(AUTH_RATE_LIMIT_CODE);
      expect(body.message).toBe(
        'Trop de tentatives de connexion. Réessayez plus tard.',
      );
      // Jamais de mot de passe, token, e-mail ni compteur exact.
      expect(
        Object.keys(body).some((k) => /remaining|hits|attempts|count/i.test(k)),
      ).toBe(false);
    });

    it('Retry-After est présent, entier strictement positif, en secondes', async () => {
      let captured = false;
      let retryAfter: string | undefined;
      for (let i = 0; i < 11; i++) {
        const res = await wrongLogin();
        if (res.status === 429) {
          retryAfter = res.headers['retry-after'];
          captured = true;
          break;
        }
      }
      expect(captured).toBe(true);
      expect(retryAfter).toBeDefined();
      const seconds = Number(retryAfter);
      expect(Number.isInteger(seconds)).toBe(true);
      expect(seconds).toBeGreaterThan(0);
    });

    it('X-Forwarded-For falsifié ne réinitialise PAS la limite (proxy non approuvé)', async () => {
      // TRUST_PROXY_HOPS absent (0) : Express IGNORE X-Forwarded-For ; le
      // tracker = l'IP réelle (boucle). 10 requêtes remplissent login-short.
      for (let i = 0; i < 10; i++) {
        const res = await wrongLogin();
        expect(res.status).toBe(401);
      }
      // 11e avec XFF falsifié : si le tracker se fiait à XFF, ce serait un
      // NOUVEAU tracker -> 401. Proxy non approuvé => même tracker -> 429.
      const forged = await request(app.getHttpServer())
        .post('/auth/login')
        .set('X-Forwarded-For', '9.9.9.9')
        .send({ email: SELLER_EMAIL, password: 'wrong-password-x' });
      expect(forged.status).toBe(429);
    });

    it('l’inscription désactivée reste 403 / REGISTRATION_DISABLED (même après plusieurs appels)', async () => {
      delete process.env.PUBLIC_REGISTRATION_ENABLED;
      for (let i = 0; i < 3; i++) {
        const res = await request(app.getHttpServer())
          .post('/auth/register')
          .send({
            name: 'RL',
            email: `rl-${i}-${Date.now()}@royalvibe.test`,
            password: 'secret-123',
          });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('REGISTRATION_DISABLED');
      }
    });
  });

  describe('9. Multi-organisation (1-3B.1) : login + switch', () => {
    // Isolation du stockage mémoire (même motif que §8) : chaque test
    // part d'une fenêtre de login vide.
    const clearThrottle = (): void => {
      const s = moduleFixture.get(ThrottlerStorage);
      s.onApplicationShutdown();
    };
    beforeEach(clearThrottle);

    const decodePayload = (token: string): Record<string, unknown> =>
      jwtService.decode(token);

    it('login mono-organisation (sans organizationId) → 201 + JWT { sub, orgId }', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: SELLER_EMAIL, password: 'seller-e2e-pw-!1x' });
      expect(res.status).toBe(201);
      const token = res.body.access_token as string;
      expect(typeof token).toBe('string');
      const payload = decodePayload(token);
      // payload métier : sub + orgId ; PAS d'email ni de role.
      expect(payload.sub).toBeDefined();
      expect(String(payload.orgId)).toBe(ORG_A_ID);
      expect(payload.email).toBeUndefined();
      expect(payload.role).toBeUndefined();
      // claims standards iat/exp : exp ≈ iat + 7 jours.
      expect(payload.iat).toBeDefined();
      expect(payload.exp).toBeDefined();
      expect(Number(payload.exp) - Number(payload.iat)).toBeGreaterThanOrEqual(
        6 * 24 * 3600,
      );
      expect(Number(payload.exp) - Number(payload.iat)).toBeLessThanOrEqual(
        8 * 24 * 3600 + 60, // tolérance d'arrondi iat + fenêtre de test
      );
    });

    it('login multi-organisation sans choix → 201, organisationSelectionRequired sans JWT', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: MULTI_EMAIL, password: MULTI_PW });
      expect(res.status).toBe(201);
      expect(res.body.organizationSelectionRequired).toBe(true);
      expect(res.body.access_token).toBeUndefined();
      expect(res.body.user).toBeUndefined();
      // liste minimale + ordonnée (tri par nom, déterministe) :
      expect(res.body.organizations).toEqual([
        { organizationId: ORG_A_ID, name: 'Org A' },
        { organizationId: ORG_B_ID, name: 'Org B' },
      ]);
      // aucune donnée sensible :
      expect(JSON.stringify(res.body)).not.toContain('membershipId');
      expect(JSON.stringify(res.body)).not.toContain('permissions');
    });

    it('login multi-organisation avec choice → 201 + JWT portant cette organisation', async () => {
      const res = await request(app.getHttpServer()).post('/auth/login').send({
        email: MULTI_EMAIL,
        password: MULTI_PW,
        organizationId: ORG_B_ID,
      });
      expect(res.status).toBe(201);
      const payload = decodePayload(res.body.access_token as string);
      expect(String(payload.orgId)).toBe(ORG_B_ID);
      expect(payload.email).toBeUndefined();
    });

    it('login avec organizationId inaccessible → 403 ORGANIZATION_ACCESS_DENIED (message uniforme)', async () => {
      // Le seller n'a de membership active que sur A : choisir B → refus
      // uniforme (même corps que tous les autres cas de refus).
      const res = await request(app.getHttpServer()).post('/auth/login').send({
        email: SELLER_EMAIL,
        password: 'seller-e2e-pw-!1x',
        organizationId: ORG_B_ID,
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ORGANIZATION_ACCESS_DENIED');
      expect(res.body.message).toBe("Accès à l'organisation refusé.");
      expect(res.body.access_token).toBeUndefined();
    });

    it('POST /auth/switch-organization A → B : 200 + nouveau JWT (même sub, new orgId)', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/switch-organization')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ organizationId: ORG_B_ID });
      expect(res.status).toBe(200);
      const payload = decodePayload(res.body.access_token as string);
      const original = decodePayload(adminToken);
      expect(payload.sub).toBe(original.sub);
      expect(String(payload.orgId)).toBe(ORG_B_ID);
      // le token original (A) reste utilisable — aucun changement persistant :
      const meRes = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(meRes.status).toBe(200);
    });

    it('POST /auth/switch-organization : sans JWT → 401', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/switch-organization')
        .send({ organizationId: ORG_A_ID });
      expect(res.status).toBe(401);
    });

    it('POST /auth/switch-organization : organisation inaccessible → 403 uniforme', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/switch-organization')
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({ organizationId: ORG_B_ID });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ORGANIZATION_ACCESS_DENIED');
      expect(res.body.message).toBe("Accès à l'organisation refusé.");
    });

    it('POST /auth/switch-organization : userId falsifié dans le body → 400 (rejeté) et ignoré', async () => {
      // forbidNonWhitelisted : `userId` n'existe pas dans le DTO → 400
      // AVANT la logique ; le sub ne provient QUE du JWT.
      const res = await request(app.getHttpServer())
        .post('/auth/switch-organization')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          organizationId: ORG_B_ID,
          userId: sellerToken && '444444444444444444444444',
        });
      expect(res.status).toBe(400);
      expect(messageOf(res.body)).toContain('userId');
    });
  });

  // 1-3B.2 — Garde organisationnelle HTTP : contexte attaché + refus uniforme.
  // Aucune infra MongoDB nouvelle : on réutilise les fixtures A/B/admin/seller.
  // Chaque test modifie un fixture (membership / org) puis le RESTAURE
  // précisément (pas de sleep, pas d'infra additionnelle). Les tests d'avant
  // (login + switch) restent verts grâce à cette restauration.
  describe('10. Contexte organisationnel HTTP (1-3B.2)', () => {
    const clearThrottle = (): void => {
      const s = moduleFixture.get(ThrottlerStorage);
      s.onApplicationShutdown();
    };
    beforeEach(clearThrottle);

    const membershipModel = (): Model<OrganizationMembershipDocument> =>
      moduleFixture.get(getModelToken(OrganizationMembership.name));
    const organizationModel = (): Model<OrganizationDocument> =>
      moduleFixture.get(getModelToken(Organization.name));
    const users = (): Model<UserDocument> =>
      moduleFixture.get(getModelToken('User'));

    // `organizationId` de la membership seller→A (cible des mutations).
    const sellerMembershipA = async () => {
      const doc = await users().findOne({ email: SELLER_EMAIL });
      expect(doc).toBeTruthy();
      const found = await membershipModel().findOne({
        organizationId: new Types.ObjectId(ORG_A_ID),
        userId: doc!._id,
      });
      expect(found).toBeTruthy();
      return found!;
    };

    // Mutation `try/finally` : même si l'assertion échoue, le fixture est
    // restauré (pas de sleep — les mutations Mongoose sont synchro-réseau).
    const withMembershipStatus = async (
      membership: OrganizationMembershipDocument,
      status: 'suspended' | 'revoked',
      fn: () => Promise<void>,
    ): Promise<void> => {
      const original = membership.status;
      membership.status =
        status === 'suspended'
          ? MembershipStatus.SUSPENDED
          : MembershipStatus.REVOKED;
      try {
        await membership.save();
        await fn();
      } finally {
        membership.status = original;
        await membership.save();
      }
    };

    const withOrgSuspended = async (
      organization: OrganizationDocument,
      fn: () => Promise<void>,
    ): Promise<void> => {
      const original = organization.status;
      organization.status = OrganizationStatus.SUSPENDED;
      try {
        await organization.save();
        await fn();
      } finally {
        organization.status = original;
        await organization.save();
      }
    };

    /**
     * Cas A : membership + org actives → GET /auth/me 200 (contrat 1-3B.1
     * intact : le handler renvoie le User Document de `request.user`).
     * `@CurrentOrganization()` n'est pas encore consommé côté E2E à ce
     * stade : la phase 1-4 (première consommation, endpoints business)
     * couvrira ce décorateur de bout en bout.
     */
    it('A — membership + org actives → GET /auth/me 200 et le corps USER du JWT', async () => {
      const res = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${sellerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.email).toBe(SELLER_EMAIL);
    });

    /**
     * Cas B : membership SUSPENDUE → 403 exact code + message + absence de
     * `access_token` / `user` dans le corps (le 403 remonte UNIFORME).
     * Restoration AUTOMATIQUE du fixture.
     */
    it('B — membership SUSPENDUE → 403 ORGANIZATION_ACCESS_DENIED (corps exact)', async () => {
      const membership = await sellerMembershipA();
      await withMembershipStatus(membership, 'suspended', async () => {
        const denied = await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `Bearer ${sellerToken}`);
        expect(denied.status).toBe(403);
        expect(denied.body.code).toBe('ORGANIZATION_ACCESS_DENIED');
        expect(denied.body.message).toBe("Accès à l'organisation refusé.");
      });
      // Post-restauration : fixture intact, seller à nouveau autorisé.
      const back = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${sellerToken}`);
      expect(back.status).toBe(200);
    });

    it('C — membership RÉVOQUÉE → 403 uniforme (même corps)', async () => {
      const membership = await sellerMembershipA();
      await withMembershipStatus(membership, 'revoked', async () => {
        const denied = await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `Bearer ${sellerToken}`);
        expect(denied.status).toBe(403);
        expect(denied.body.code).toBe('ORGANIZATION_ACCESS_DENIED');
        expect(denied.body.message).toBe("Accès à l'organisation refusé.");
      });
      const back = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${sellerToken}`);
      expect(back.status).toBe(200);
    });

    it('D — membership SUPPRIMÉE → 403 uniforme (fixture restaurée)', async () => {
      const sellerId = (await users().findOne({ email: SELLER_EMAIL }))!._id;
      // Snapshot EXACT (même _id, tous champs) AVANT suppression : la
      // restauration se fait par ré-insertion brute — plus fiable qu'une
      // re-création Mongoose (readback instable constaté sur cette instance
      // ; la doc origine est la source de vérité, _id non régénéré).
      const rawMemberships = moduleFixture
        .get(getConnectionToken())
        .getClient()
        .db(E2E_DB_NAME)
        .collection('organizationmemberships');
      const snapshot = await rawMemberships
        .find({
          organizationId: new Types.ObjectId(ORG_A_ID),
          userId: sellerId,
        })
        .toArray();
      expect(snapshot.length).toBe(1);
      // Suppression par la collection brute (même _id) — canal unique de
      // mutation/restauration de ce fixture (évite l'API `deleteOne` d'un
      // document Mongoose, indisponible ici).
      await rawMemberships.deleteOne({ _id: snapshot[0]._id });
      try {
        const denied = await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `Bearer ${sellerToken}`);
        expect(denied.status).toBe(403);
        expect(denied.body.code).toBe('ORGANIZATION_ACCESS_DENIED');
        expect(denied.body.message).toBe("Accès à l'organisation refusé.");
      } finally {
        await rawMemberships.insertMany(snapshot);
        // Invariant de restauration : la doc d'origine (même _id) est de
        // nouveau présente et `active` — lue via LE MÊME canal que la
        // résolution (`resolveActiveContext` lit par le modèle Mongoose de
        // la connexion Nest, base physique identique).
        const restoredRaw = await rawMemberships
          .find({
            // `_id` BSON non typé (any) : String() → string strict.
            _id: new Types.ObjectId(String(snapshot[0]._id)),
          })
          .toArray();
        expect(restoredRaw.length).toBe(1);
        // Docs brutes BSON (non typées) : extraction `unknown` typée pour
        // l'assertion (pas d'arg `any` passé en paramètre).
        const restoredStatus: unknown = (restoredRaw[0] as { status: unknown })
          .status;
        expect(restoredStatus).toBe('active');
      }
      const back = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${sellerToken}`);
      expect(back.status).toBe(200);
    });

    it('E — org SUSPENDUE → 403 uniforme (org A ré-activée en fin de test)', async () => {
      const orgA = await organizationModel().findById(
        new Types.ObjectId(ORG_A_ID),
      );
      expect(orgA).toBeTruthy();
      await withOrgSuspended(orgA!, async () => {
        const denied = await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `Bearer ${sellerToken}`);
        expect(denied.status).toBe(403);
        expect(denied.body.code).toBe('ORGANIZATION_ACCESS_DENIED');
        expect(denied.body.message).toBe("Accès à l'organisation refusé.");
      });
      const back = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${sellerToken}`);
      expect(back.status).toBe(200);
    });

    /**
     * Cas F : SANS JWT → 401 (JwtAuthGuard refuse AVANT la guard).
     * La 403 n'arrive pas — `OrganizationGuard` ne s'exécute même pas.
     */
    it('F — sans JWT → 401 (JwtAuthGuard refuse avant la guard)', () =>
      request(app.getHttpServer()).get('/auth/me').expect(401));

    /**
     * Cas G : `/auth/login` reste PUBLIQUE et conserve le contrat 1-3B.1
     * (201 + corps `{ access_token, user }`). Les routes @Public() sont
     * exclues de la guard (mécanisme `IS_PUBLIC_KEY` — cf. `JwtAuthGuard`).
     * Le `user` retourné ne doit pas exposer `password` ni `organizationId`.
     */
    it('G — POST /auth/login reste PUBLIQUE (201, contrat 1-3B.1 intact)', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: SELLER_EMAIL, password: 'seller-e2e-pw-!1x' });
      expect(res.status).toBe(201);
      expect(typeof res.body.access_token).toBe('string');
      expect(res.body.user.email).toBe(SELLER_EMAIL);
      // Le corps `user` ne doit PAS exposer le hash (sanitize 1-3B.1) ni
      // la transient `organizationId` du principal (serveur uniquement,
      // jamais sérialisée dans le corps).
      expect(res.body.user.password).toBeUndefined();
      expect(res.body.user.organizationId).toBeUndefined();
      expect(JSON.stringify(res.body.user)).not.toContain('organizationId');
    });

    /**
     * Cas H : `organizationId` FALSIFIÉE dans le body / header / query /
     * params ne remplace JAMAIS l'org du JWT. La guard ne se fie qu'au
     * principal (`request.user.organizationId`), attaché par la stratégie.
     *
     * `/auth/me` (GET) n'accepte pas de body/query — les headers et les
     * `Authorization` falsifiés couvrent le cas ; la `orgId` signée reste
     * celle d'origine (`ORG_A_ID`, non remplacée). Le cas "query/params
     * falsifiés" se verra à la phase 1-4 sur les endpoints business qui
     * ont de telles routes (ex. `?organizationId=forged`).
     */
    it("H — organizationId FALSIFIÉE (body/header/query) ne remplace JAMAIS l'org signée", async () => {
      // Body + 2 headers falsifiés sur un GET : le corps du 200 reste celui
      // de l'admin (org A signée). `organizationId` n'est jamais lu.
      const forged = await request(app.getHttpServer())
        .get('/auth/me?organizationId=' + FORGED_ORG_ID)
        .set('x-organization-id', FORGED_ORG_ID)
        .set('organization-id', FORGED_ORG_ID)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ organizationId: FORGED_ORG_ID });
      expect(forged.status).toBe(200);
      expect(forged.body.email).toBe(ADMIN_EMAIL);
    });
  });
});
