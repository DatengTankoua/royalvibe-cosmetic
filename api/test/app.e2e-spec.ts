import 'reflect-metadata';
import { Connection, Model } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument, UserRole } from './../src/users/schemas/user.schema';
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

      moduleFixture = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleFixture.createNestApplication();
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
      const login = (email: string, password: string) =>
        request(app.getHttpServer())
          .post('/auth/login')
          .send({ email, password });

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

      const adminLogin = await login(ADMIN_EMAIL, 'admin-e2e-pw-!1x');
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
});
