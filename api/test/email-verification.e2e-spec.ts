import 'reflect-metadata';
import type { AddressInfo } from 'net';
import { randomUUID, createHash } from 'crypto';
import { Model, Types } from 'mongoose';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { io } from 'socket.io-client';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument } from './../src/users/schemas/user.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import { Product } from './../src/products/schemas/product.schema';
import type { ProductDocument } from './../src/products/schemas/product.schema';
import { Sale } from './../src/sales/schemas/sale.schema';
import type { SaleDocument } from './../src/sales/schemas/sale.schema';
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
import {
  EMAIL_SENDER,
  type EmailSender,
  type OutgoingEmail,
} from '../src/email-verification/email-sender';
import { ResendEmailSender } from '../src/email-verification/resend-email-sender';
import { EMAIL_VERIFICATION_REQUEST_ACCEPTED_MESSAGE } from '../src/auth/auth.controller';
import {
  E2E_EMAIL_VERIFIED_AT,
  RecordingEmailSender,
  verificationTokenFrom,
} from './e2e/email-verification-fixtures';
import { INVITATION_TERMS, OWNER_TERMS } from './e2e/legal-acceptance-fixtures';

/**
 * E2E 1-13A — vérification des emails : `MongoMemoryReplSet` éphémère,
 * expéditeur SIMULÉ (aucun appel Resend : `fetch` toujours mocké quand
 * l'expéditeur Resend réel est branché), serveur Socket.IO réel.
 */

const TEST_JWT_SECRET = 'email-verification-e2e-only-secret';
const E2E_CORS_ORIGIN = 'https://email-verification-e2e.example.com';
const PUBLIC_APP_URL = 'https://app.email-verification-e2e.test';
const PASSWORD = 'email-verif-13a-pw-!1x';

/** Expéditeur commutable : simulé par défaut, Resend réel (fetch mocké) au besoin. */
class SwitchableEmailSender implements EmailSender {
  constructor(public current: EmailSender) {}
  isConfigured(): boolean {
    return this.current.isConfigured();
  }
  send(email: OutgoingEmail): Promise<void> {
    return this.current.send(email);
  }
}

const recorder = new RecordingEmailSender();
const emailSender = new SwitchableEmailSender(recorder);

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

describe('Vérification des emails (e2e 1-13A)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let port = 0;
  let userModel: Model<UserDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let productModel: Model<ProductDocument>;
  let saleModel: Model<SaleDocument>;
  const logs: string[] = [];
  const seenTokens = new Set<string>();

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = (email: string, organizationId?: string) =>
    http()
      .post('/auth/login')
      .send({ email, password: PASSWORD, organizationId });
  const requestLink = (email: string) =>
    http().post('/auth/email-verification/request').send({ email });
  const confirm = (body: Record<string, unknown>) =>
    http().post('/auth/email-verification/confirm').send(body);

  const lastEmailTo = (email: string): OutgoingEmail => {
    const sent = recorder.sentTo(email);
    if (sent.length === 0) throw new Error(`no email to ${email}`);
    const last = sent[sent.length - 1];
    seenTokens.add(verificationTokenFrom(last));
    return last;
  };
  const lastTokenTo = (email: string) =>
    verificationTokenFrom(lastEmailTo(email));

  const internals = (email: string) =>
    userModel
      .findOne({ email })
      .select(
        '+emailVerificationTokenHash +emailVerificationExpiresAt +emailVerificationLastSentAt +emailVerificationWindowStartedAt +emailVerificationSendCount',
      )
      .lean()
      .exec();

  /** Fin de cooldown simulée (aucun sleep réel de 60 s). */
  const expireCooldown = (email: string) =>
    userModel
      .updateOne(
        { email },
        {
          $set: {
            emailVerificationLastSentAt: new Date(Date.now() - 61_000),
          },
        },
      )
      .exec();

  async function registerOwner(
    email: string,
    organizationName: string,
  ): Promise<{ orgId: string; body: Record<string, unknown> }> {
    const res = await http()
      .post('/auth/register')
      .send({
        ...OWNER_TERMS,
        name: 'Owner',
        email,
        password: PASSWORD,
        organizationName,
      });
    expect(res.status).toBe(201);
    return {
      orgId: (res.body as { organization: { _id: string } }).organization._id,
      body: res.body as Record<string, unknown>,
    };
  }

  /** Propriétaire vérifié par le parcours réel (lien consommé). */
  async function verifiedOwner(email: string, organizationName: string) {
    const { orgId } = await registerOwner(email, organizationName);
    const confirmed = await confirm({ token: lastTokenTo(email) });
    expect(confirmed.status).toBe(200);
    const res = await login(email, orgId);
    expect(res.status).toBe(201);
    return { orgId, token: res.body.access_token as string };
  }

  function socketAttempt(
    token: string,
  ): Promise<{ connected: boolean; error?: string }> {
    const socket = io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 4_000,
      extraHeaders: { origin: E2E_CORS_ORIGIN },
      auth: { token },
    });
    return new Promise((resolve) => {
      const done = (result: { connected: boolean; error?: string }) => {
        clearTimeout(timer);
        socket.close();
        resolve(result);
      };
      const timer = setTimeout(
        () => done({ connected: false, error: 'timeout' }),
        5_000,
      );
      socket.once('connect', () => done({ connected: true }));
      socket.once('connect_error', (err: Error) =>
        done({ connected: false, error: err.message }),
      );
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
      process.env.PUBLIC_APP_URL = PUBLIC_APP_URL;

      // Journal capturé (et silencieux) : aucun token, hash ni adresse.
      for (const method of [
        'log',
        'warn',
        'error',
        'debug',
        'verbose',
      ] as const) {
        jest.spyOn(Logger.prototype, method).mockImplementation(function (
          this: Logger,
          ...args: unknown[]
        ) {
          logs.push(
            `[${String((this as unknown as { context?: string }).context)}] ${args.map(String).join(' ')}`,
          );
        });
      }

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
      await app.listen(0);
      port = (app.getHttpServer().address() as AddressInfo).port;

      userModel = moduleFixture.get(getModelToken('User'));
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );
      productModel = moduleFixture.get(getModelToken(Product.name));
      saleModel = moduleFixture.get(getModelToken(Sale.name));
    } catch (err) {
      await stopEphemeralMongoSafe();
      throw err;
    }
  }, 180_000);

  // Rate limiting existant remis à zéro entre les tests (même IP locale).
  beforeEach(() => {
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
    emailSender.current = recorder;
    recorder.failure = null;
    recorder.configured = true;
    process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
    jest.restoreAllMocks();
  }, 60_000);

  describe('1. Inscription → non vérifié → confirmation → connexion', () => {
    it('parcours complet, preuve stockée en SHA-256 seulement, aucun JWT à la confirmation', async () => {
      const email = 'owner-1-13a@verify.test';
      const { orgId, body } = await registerOwner(email, 'Org 13A');
      expect(body.emailVerification).toEqual({ status: 'sent' });
      expect(JSON.stringify(body)).not.toMatch(/token|hash/i);

      const stored = await internals(email);
      expect(stored!.emailVerifiedAt ?? null).toBeNull();
      const token = lastTokenTo(email);
      expect(Buffer.from(token, 'base64url').length).toBeGreaterThanOrEqual(32);
      expect(stored!.emailVerificationTokenHash).toBe(sha256(token));
      expect(
        stored!.emailVerificationExpiresAt!.getTime() - Date.now(),
      ).toBeGreaterThan(23.9 * 3600 * 1000);

      const email1 = lastEmailTo(email);
      expect(email1.text).toContain(
        `${PUBLIC_APP_URL}/auth/verify-email?token=${encodeURIComponent(token)}`,
      );
      expect(email1.html).toContain('Confirmer mon adresse email');

      const refused = await login(email, orgId);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('EMAIL_NOT_VERIFIED');
      expect(refused.body.access_token).toBeUndefined();

      const confirmed = await confirm({ token });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body).toEqual({ verified: true });
      expect(confirmed.headers['cache-control']).toBe('no-store');

      const after = await internals(email);
      expect(after!.emailVerifiedAt).toBeInstanceOf(Date);
      expect(after!.emailVerificationTokenHash).toBeUndefined();

      const ok = await login(email, orgId);
      expect(ok.status).toBe(201);
      expect(typeof ok.body.access_token).toBe('string');
    });
  });

  describe('2. Invitation, inscription publique fermée', () => {
    it('compte créé par invitation : non vérifié, puis organisation et permissions conservées après confirmation', async () => {
      const owner = await verifiedOwner('owner-2-13a@verify.test', 'Org Inv');
      process.env.PUBLIC_REGISTRATION_ENABLED = 'false';
      const closed = await http()
        .post('/auth/register')
        .send({
          ...OWNER_TERMS,
          name: 'X',
          email: 'closed-13a@verify.test',
          password: PASSWORD,
          organizationName: 'X',
        });
      expect(closed.status).toBe(403);

      const invited = 'invited-13a@verify.test';
      const inv = await http()
        .post('/organizations/invitations')
        .set(auth(owner.token))
        .send({
          email: invited,
          role: 'seller',
          permissions: ['products.view_financials'],
        });
      expect(inv.status).toBe(201);
      // Aucun email automatique à la création d'une invitation.
      expect(recorder.sentTo(invited)).toHaveLength(0);
      const invitationToken = new URL(
        inv.body.invitationUrl as string,
      ).searchParams.get('token')!;

      const accepted = await http()
        .post('/auth/invitations/accept')
        .send({
          ...INVITATION_TERMS,
          token: invitationToken,
          name: 'Invited',
          password: PASSWORD,
        });
      expect(accepted.status).toBe(200);
      expect(accepted.body.emailVerification).toEqual({ status: 'sent' });
      // Le lien d'invitation n'est PAS une preuve d'accès à la boîte mail.
      expect((await internals(invited))!.emailVerifiedAt ?? null).toBeNull();

      const refused = await login(invited, owner.orgId);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('EMAIL_NOT_VERIFIED');

      const membershipBefore = await membershipModel
        .findOne({ userId: (await internals(invited))!._id })
        .lean()
        .exec();
      expect((await confirm({ token: lastTokenTo(invited) })).status).toBe(200);
      const membershipAfter = await membershipModel
        .findOne({ userId: (await internals(invited))!._id })
        .lean()
        .exec();
      expect(membershipAfter).toEqual(membershipBefore);

      const ok = await login(invited, owner.orgId);
      expect(ok.status).toBe(201);
      const context = await http()
        .get('/auth/context')
        .set(auth(ok.body.access_token as string));
      expect(context.status).toBe(200);
      expect(context.body.role).toBe('seller');
      expect(context.body.permissions).toEqual(['products.view_financials']);
    });

    it('compte existant déjà vérifié qui accepte une invitation : aucun envoi (not_required)', async () => {
      const owner = await verifiedOwner(
        'owner-2b-13a@verify.test',
        'Org Inv B',
      );
      const existing = 'existing-2b-13a@verify.test';
      await userModel.create({
        emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
        name: 'Existing',
        email: existing,
        password: await bcrypt.hash(PASSWORD, 10),
      });
      const inv = await http()
        .post('/organizations/invitations')
        .set(auth(owner.token))
        .send({ email: existing, role: 'seller' });
      const token = new URL(inv.body.invitationUrl as string).searchParams.get(
        'token',
      );
      const accepted = await http()
        .post('/auth/invitations/accept')
        .send({ token });
      expect(accepted.status).toBe(200);
      expect(accepted.body.emailVerification).toEqual({
        status: 'not_required',
      });
      expect(recorder.sentTo(existing)).toHaveLength(0);
    });
  });

  describe('3 + 8 + 10. Compte historique, ancien JWT, Socket.IO et reprise des ventes', () => {
    it('ancien JWT et Socket.IO refusés tant que non vérifié ; vérification sans perte ; vente idempotente reprise', async () => {
      const email = 'historic-13a@verify.test';
      const owner = await verifiedOwner(email, 'Org Historique');
      const oldJwt = owner.token;
      const sectionRes = await http()
        .post('/sections')
        .set(auth(oldJwt))
        .send({ name: 'Section 13A' });
      expect(sectionRes.status).toBe(201);
      const product = await productModel.create({
        organizationId: new Types.ObjectId(owner.orgId),
        sectionId: new Types.ObjectId(sectionRes.body._id as string),
        name: 'Produit 13A',
        imageUrl: 'https://e2e.local/img.png',
        purchasePrice: 100,
        salePrice: 250,
        initialQuantity: 20,
        remainingQuantity: 20,
      });
      const firstSale = await http().post('/sales').set(auth(oldJwt)).send({
        productId: product._id.toString(),
        quantity: 1,
        salePrice: 250,
      });
      expect(firstSale.status).toBe(201);
      expect((await socketAttempt(oldJwt)).connected).toBe(true);

      // Document historique (antérieur à 1-13A) : aucun champ de vérification.
      await userModel
        .updateOne(
          { email },
          {
            $unset: {
              emailVerifiedAt: 1,
              emailVerificationLastSentAt: 1,
              emailVerificationWindowStartedAt: 1,
              emailVerificationSendCount: 1,
            },
          },
        )
        .exec();
      const before = {
        user: await userModel.findOne({ email }).select('+password').lean(),
        memberships: await membershipModel
          .find({ organizationId: new Types.ObjectId(owner.orgId) })
          .lean(),
        sales: await saleModel
          .find({ organizationId: new Types.ObjectId(owner.orgId) })
          .lean(),
      };

      // 8. Ancien JWT (signé, non expiré) refusé partout.
      for (const path of ['/auth/context', '/auth/me', '/products']) {
        const res = await http().get(path).set(auth(oldJwt));
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
      }
      const switched = await http()
        .post('/auth/switch-organization')
        .set(auth(oldJwt))
        .send({ organizationId: owner.orgId });
      expect(switched.status).toBe(401);
      expect(await socketAttempt(oldJwt)).toEqual({
        connected: false,
        error: 'unauthorized',
      });

      // 10. Vente en attente (outbox) rejouée avec l'ancien JWT : refusée,
      //     rien n'est enregistré.
      const pendingOperation = {
        productId: product._id.toString(),
        quantity: 2,
        salePrice: 240,
        clientOperationId: randomUUID(),
        occurredAt: new Date().toISOString(),
      };
      const blocked = await http()
        .post('/sales')
        .set(auth(oldJwt))
        .send(pendingOperation);
      expect(blocked.status).toBe(401);
      expect(
        await saleModel.countDocuments({
          organizationId: new Types.ObjectId(owner.orgId),
        }),
      ).toBe(before.sales.length);

      // 3. Le compte historique reçoit un lien et se vérifie.
      const refused = await login(email, owner.orgId);
      expect(refused.body.code).toBe('EMAIL_NOT_VERIFIED');
      const sentBefore = recorder.sentTo(email).length;
      const resend = await requestLink(email);
      expect(resend.status).toBe(202);
      await waitFor(() => recorder.sentTo(email).length === sentBefore + 1);
      expect((await confirm({ token: lastTokenTo(email) })).status).toBe(200);

      const afterUser = await userModel
        .findOne({ email })
        .select('+password')
        .lean();
      expect(afterUser!._id).toEqual(before.user!._id);
      expect(afterUser!.password).toBe(before.user!.password);
      expect(afterUser!.name).toBe(before.user!.name);
      expect(afterUser!.role).toBe(before.user!.role);
      expect(
        await membershipModel
          .find({ organizationId: new Types.ObjectId(owner.orgId) })
          .lean(),
      ).toEqual(before.memberships);
      expect(
        await saleModel
          .find({ organizationId: new Types.ObjectId(owner.orgId) })
          .lean(),
      ).toEqual(before.sales);

      // Connexion autorisée → reprise de l'opération en attente, une seule fois.
      const ok = await login(email, owner.orgId);
      expect(ok.status).toBe(201);
      const newJwt = ok.body.access_token as string;
      const replayed = await http()
        .post('/sales')
        .set(auth(newJwt))
        .send(pendingOperation);
      expect(replayed.status).toBe(201);
      const again = await http()
        .post('/sales')
        .set(auth(newJwt))
        .send(pendingOperation);
      expect([200, 201]).toContain(again.status);
      expect(again.body._id).toBe(replayed.body._id);
      expect(
        await saleModel.countDocuments({
          organizationId: new Types.ObjectId(owner.orgId),
        }),
      ).toBe(before.sales.length + 1);
      expect((await socketAttempt(newJwt)).connected).toBe(true);
    });
  });

  describe('4. Compte déjà vérifié', () => {
    it('connexion normale ; une demande de lien ne déclenche aucun envoi', async () => {
      const owner = await verifiedOwner('verified-4-13a@verify.test', 'Org V');
      expect(typeof owner.token).toBe('string');
      const sent = recorder.sentTo('verified-4-13a@verify.test').length;
      const res = await requestLink('verified-4-13a@verify.test');
      expect(res.status).toBe(202);
      await settle();
      expect(recorder.sentTo('verified-4-13a@verify.test')).toHaveLength(sent);
    });
  });

  describe('5. Tokens refusés', () => {
    it('absent, vide, mal typé, injection, inconnu → 400 stable', async () => {
      for (const body of [
        {},
        { token: '' },
        { token: 42 },
        { token: { $ne: null } },
        { token: 'x'.repeat(600) },
        { token: 'unknown-token-value-13a' },
      ]) {
        const res = await confirm(body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('EMAIL_VERIFICATION_INVALID_OR_EXPIRED');
        expect(res.body.message).toBe(
          'Ce lien de confirmation est invalide ou a expiré.',
        );
      }
    });

    it('expiré → 400, compte non vérifié', async () => {
      const email = 'expired-13a@verify.test';
      await registerOwner(email, 'Org Exp');
      const token = lastTokenTo(email);
      await userModel
        .updateOne(
          { email },
          { $set: { emailVerificationExpiresAt: new Date(Date.now() - 1) } },
        )
        .exec();
      const res = await confirm({ token });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('EMAIL_VERIFICATION_INVALID_OR_EXPIRED');
      expect((await internals(email))!.emailVerifiedAt ?? null).toBeNull();
    });

    it('déjà utilisé → 400 ; confirmations concurrentes → une seule réussite', async () => {
      const email = 'concurrent-13a@verify.test';
      await registerOwner(email, 'Org Conc');
      const token = lastTokenTo(email);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => confirm({ token })),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 400, 400, 400, 400]);
      const reused = await confirm({ token });
      expect(reused.status).toBe(400);
      expect(reused.body.code).toBe('EMAIL_VERIFICATION_INVALID_OR_EXPIRED');
    });
  });

  describe('6. Renvoi, cooldown, remplacement et réponse neutre', () => {
    it('réponse identique pour compte inconnu, vérifié, non vérifié et en cooldown', async () => {
      const unverified = 'neutral-13a@verify.test';
      await registerOwner(unverified, 'Org Neutral');
      await verifiedOwner('neutral-verified-13a@verify.test', 'Org NV');
      const bodies: unknown[] = [];
      for (const email of [
        'nobody-13a@verify.test',
        'neutral-verified-13a@verify.test',
        unverified, // en cooldown (lien de l'inscription)
      ]) {
        const res = await requestLink(email);
        expect(res.status).toBe(202);
        expect(res.headers['cache-control']).toBe('no-store');
        bodies.push(res.body);
      }
      await expireCooldown(unverified);
      const fresh = await requestLink(unverified);
      expect(fresh.status).toBe(202);
      bodies.push(fresh.body);
      for (const body of bodies) {
        expect(body).toEqual({
          message: EMAIL_VERIFICATION_REQUEST_ACCEPTED_MESSAGE,
        });
      }
    });

    it('cooldown de 60 s, remplacement du lien précédent, clé d’idempotence par émission', async () => {
      const email = 'resend-13a@verify.test';
      await registerOwner(email, 'Org Resend');
      const firstToken = lastTokenTo(email);

      await requestLink(email);
      await settle();
      expect(recorder.sentTo(email)).toHaveLength(1); // cooldown

      await expireCooldown(email);
      await requestLink(email);
      await waitFor(() => recorder.sentTo(email).length === 2);
      const secondToken = lastTokenTo(email);
      expect(secondToken).not.toBe(firstToken);
      const keys = recorder.sentTo(email).map((m) => m.idempotencyKey);
      expect(new Set(keys).size).toBe(2);

      expect((await confirm({ token: firstToken })).status).toBe(400);
      expect((await confirm({ token: secondToken })).status).toBe(200);
    });

    it('demandes concurrentes : un seul envoi', async () => {
      const email = 'race-13a@verify.test';
      await registerOwner(email, 'Org Race');
      await expireCooldown(email);
      const before = recorder.sentTo(email).length;
      const results = await Promise.all(
        Array.from({ length: 5 }, () => requestLink(email)),
      );
      expect(results.map((r) => r.status)).toEqual([202, 202, 202, 202, 202]);
      await settle();
      expect(recorder.sentTo(email)).toHaveLength(before + 1);
    });

    it('plafond horaire par compte : aucun envoi au-delà', async () => {
      const email = 'cap-13a@verify.test';
      await registerOwner(email, 'Org Cap');
      await userModel
        .updateOne(
          { email },
          {
            $set: {
              emailVerificationLastSentAt: new Date(Date.now() - 120_000),
              emailVerificationWindowStartedAt: new Date(Date.now() - 600_000),
              emailVerificationSendCount: 5,
            },
          },
        )
        .exec();
      const before = recorder.sentTo(email).length;
      expect((await requestLink(email)).status).toBe(202);
      await settle();
      expect(recorder.sentTo(email)).toHaveLength(before);
    });

    it('limitation par adresse normalisée (existante ou non) : 429 stable au-delà de 5', async () => {
      const statuses: number[] = [];
      for (const variant of [
        'ratelimit-13a@verify.test',
        'RateLimit-13a@verify.test',
        '  ratelimit-13a@VERIFY.test ',
        'ratelimit-13a@verify.test',
        'ratelimit-13a@verify.test',
        'ratelimit-13a@verify.test',
      ]) {
        const res = await requestLink(variant);
        statuses.push(res.status);
        if (res.status === 429) {
          expect(res.body.code).toBe('EMAIL_VERIFICATION_RATE_LIMITED');
          expect(JSON.stringify(res.body)).not.toContain('ratelimit');
          expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
        }
      }
      expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
    });

    it('adresse invalide → 400 de validation', async () => {
      const res = await requestLink('pas-une-adresse');
      expect(res.status).toBe(400);
    });
  });

  describe('7. Échecs Resend et configuration absente', () => {
    let fetchMock: jest.SpyInstance;
    const resendConfig = (env: Record<string, string | undefined>) =>
      ({ get: (key: string) => env[key] }) as unknown as ConfigService;

    beforeEach(() => {
      // Aucun appel réseau réel, quelle que soit la configuration locale.
      fetchMock = jest.spyOn(global, 'fetch');
      fetchMock.mockRejectedValue(new Error('unexpected real fetch'));
    });
    afterEach(() => fetchMock.mockRestore());

    const configuredResend = () =>
      new ResendEmailSender(
        resendConfig({
          RESEND_API_KEY: 're_e2e_fake',
          EMAIL_FROM: 'Stock Master <no-reply@verify.test>',
        }),
      );

    it.each([
      [
        'refusé (HTTP 422)',
        () => Promise.resolve(new Response('{}', { status: 422 })),
      ],
      [
        'indisponible (HTTP 503)',
        () => Promise.resolve(new Response('{}', { status: 503 })),
      ],
      ['injoignable', () => Promise.reject(new TypeError('fetch failed'))],
      [
        'timeout',
        () =>
          Promise.reject(
            Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
          ),
      ],
    ])(
      'Resend %s : compte créé une fois, non vérifié, renvoi ultérieur possible',
      async (_label, behaviour) => {
        const email = `fail-${randomUUID().slice(0, 8)}-13a@verify.test`;
        emailSender.current = configuredResend();
        fetchMock.mockImplementation(behaviour);

        const { orgId, body } = await registerOwner(email, 'Org Fail');
        expect(body.emailVerification).toEqual({ status: 'failed' });
        expect(JSON.stringify(body)).not.toMatch(/resend|http|422|503/i);
        expect(fetchMock).toHaveBeenCalledTimes(1); // aucune relance
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://api.resend.com/emails');
        expect((init.headers as Record<string, string>).Authorization).toBe(
          'Bearer re_e2e_fake',
        );

        expect(await userModel.countDocuments({ email })).toBe(1);
        expect((await internals(email))!.emailVerifiedAt ?? null).toBeNull();
        const duplicate = await http()
          .post('/auth/register')
          .send({
            ...OWNER_TERMS,
            name: 'Owner',
            email,
            password: PASSWORD,
            organizationName: 'Org Fail 2',
          });
        expect(duplicate.status).toBe(400);
        expect(await userModel.countDocuments({ email })).toBe(1);
        expect((await login(email, orgId)).body.code).toBe(
          'EMAIL_NOT_VERIFIED',
        );

        // Renvoi ultérieur, fournisseur rétabli (simulé).
        emailSender.current = recorder;
        await expireCooldown(email);
        expect((await requestLink(email)).status).toBe(202);
        await waitFor(() => recorder.sentTo(email).length === 1);
        expect((await confirm({ token: lastTokenTo(email) })).status).toBe(200);
        expect((await login(email, orgId)).status).toBe(201);
      },
    );

    it('configuration absente : inscription conservée (failed) ; renvoi 503 identique pour toute adresse, sans appel réseau', async () => {
      emailSender.current = new ResendEmailSender(
        resendConfig({ EMAIL_FROM: 'no-reply@verify.test' }),
      );
      const email = 'noconfig-13a@verify.test';
      const { body } = await registerOwner(email, 'Org NoConf');
      expect(body.emailVerification).toEqual({ status: 'failed' });
      expect(await userModel.countDocuments({ email })).toBe(1);

      const known = await requestLink(email);
      const unknown = await requestLink('nobody-noconfig-13a@verify.test');
      for (const res of [known, unknown]) {
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('EMAIL_DELIVERY_UNAVAILABLE');
      }
      expect(known.body.message).toBe(unknown.body.message);
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await internals(email))!.emailVerifiedAt ?? null).toBeNull();
    });

    it('PUBLIC_APP_URL invalide : même erreur contrôlée, aucun envoi', async () => {
      process.env.PUBLIC_APP_URL = 'https://app.verify.test/avec-chemin';
      try {
        const res = await requestLink('whoever-13a@verify.test');
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('EMAIL_DELIVERY_UNAVAILABLE');
      } finally {
        process.env.PUBLIC_APP_URL = PUBLIC_APP_URL;
      }
    });
  });

  describe('9. Aucune fuite de token, hash ou champ interne', () => {
    it('réponses utilisateur, profil, membres et journaux', async () => {
      const owner = await verifiedOwner('leak-13a@verify.test', 'Org Leak');
      const me = await http().get('/auth/me').set(auth(owner.token));
      const members = await http()
        .get('/organizations/current/members')
        .set(auth(owner.token));
      const context = await http().get('/auth/context').set(auth(owner.token));
      for (const res of [me, members, context]) {
        expect(JSON.stringify(res.body)).not.toMatch(
          /emailVerification(TokenHash|ExpiresAt|LastSentAt|WindowStartedAt|SendCount)|tokenHash/,
        );
      }
      const hashes = [...seenTokens].map(sha256);
      const allLogs = logs.join('\n');
      for (const secret of [...seenTokens, ...hashes]) {
        expect(allLogs).not.toContain(secret);
      }
      expect(allLogs).not.toContain('/auth/verify-email');
      expect(allLogs).not.toContain('re_e2e_fake');
      const verificationLogs = logs.filter((l) =>
        l.startsWith('[EmailVerification]'),
      );
      expect(verificationLogs.length).toBeGreaterThan(0);
      for (const line of verificationLogs) {
        expect(line).not.toContain('@');
      }
    });
  });
});
