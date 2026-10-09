import 'reflect-metadata';
import type { AddressInfo } from 'net';
import { createHash, randomUUID } from 'crypto';
import { Model, Types } from 'mongoose';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument } from './../src/users/schemas/user.schema';
import { Product } from './../src/products/schemas/product.schema';
import type { ProductDocument } from './../src/products/schemas/product.schema';
import { Sale } from './../src/sales/schemas/sale.schema';
import type { SaleDocument } from './../src/sales/schemas/sale.schema';
import { SocketRegistryService } from './../src/organizations/socket-registry.service';
import { OrganizationsService } from './../src/organizations/organizations.service';
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
import { PASSWORD_RESET_REQUEST_ACCEPTED_MESSAGE } from '../src/auth/auth.controller';
import {
  PASSWORD_CHANGED_SUBJECT,
  PASSWORD_CHANGED_SUBJECT_EN,
} from '../src/password-reset/password-reset-email';
import {
  RecordingEmailSender,
  verificationTokenFrom,
} from './e2e/email-verification-fixtures';
import { acceptWithSession } from './e2e/invitation-acceptance-fixtures';
import {
  OWNER_TERMS,
  simulatedTurnstileToken,
} from './e2e/legal-acceptance-fixtures';

/**
 * E2E 1-13B — mot de passe oublié et réinitialisation : `MongoMemoryReplSet`
 * éphémère, expéditeur SIMULÉ (`fetch` toujours mocké quand l'expéditeur
 * Resend réel est branché), serveur Socket.IO réel.
 */

const TEST_JWT_SECRET = 'password-reset-e2e-only-secret';
const E2E_CORS_ORIGIN = 'https://password-reset-e2e.example.com';
const PUBLIC_APP_URL = 'https://app.password-reset-e2e.test';
const PASSWORD = 'reset-13b-old-pw-!1x';
const NEW_PASSWORD = 'reset-13b-new-pw-!2y';

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
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

/** Barrière déterministe : `reached` quand l'appel est suspendu, `release()` pour le reprendre. */
function makeBarrier() {
  let signal: () => void = () => undefined;
  let release: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => (signal = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    reached,
    released,
    signal: () => signal(),
    release: () => release(),
  };
}

const claimsOf = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()) as Record<
    string,
    unknown
  >;

async function waitFor(predicate: () => boolean, timeoutMs = 3_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function resetTokenFrom(email: OutgoingEmail): string {
  const match = /\/auth\/reset-password\?token=([^\s"&]+)/.exec(email.text);
  if (!match) throw new Error('No reset link in email');
  return decodeURIComponent(match[1]);
}

describe('Mot de passe oublié et réinitialisation (e2e 1-13B)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let port = 0;
  let userModel: Model<UserDocument>;
  let productModel: Model<ProductDocument>;
  let saleModel: Model<SaleDocument>;
  let jwtService: JwtService;
  const logs: string[] = [];
  const seenTokens = new Set<string>();

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = (email: string, password: string, organizationId?: string) =>
    http().post('/auth/login').send({ email, password, organizationId });
  // 1-18D : défi anti-robot simulé neuf (action propre à la route).
  const requestReset = (email: string) =>
    http()
      .post('/auth/password-reset/request')
      .send({
        email,
        turnstileToken: simulatedTurnstileToken('password-reset'),
      });
  const confirmReset = (body: Record<string, unknown>) =>
    http().post('/auth/password-reset/confirm').send(body);

  const resetMailsTo = (email: string) =>
    recorder
      .sentTo(email)
      .filter((m) => m.text.includes('/auth/reset-password?token='));
  async function nextResetToken(email: string, count: number) {
    await waitFor(() => resetMailsTo(email).length >= count);
    const token = resetTokenFrom(resetMailsTo(email)[count - 1]);
    seenTokens.add(token);
    return token;
  }
  const internals = (email: string) =>
    userModel
      .findOne({ email })
      .select(
        '+password +authVersion +passwordResetTokenHash +passwordResetExpiresAt +passwordResetLastSentAt +emailVerificationTokenHash',
      )
      .lean()
      .exec();
  const expireCooldown = (email: string) =>
    userModel
      .updateOne(
        { email },
        { $set: { passwordResetLastSentAt: new Date(Date.now() - 61_000) } },
      )
      .exec();

  /** Propriétaire vérifié par le parcours réel de 1-13A. */
  async function verifiedOwner(email: string, organizationName: string) {
    const reg = await http()
      .post('/auth/register')
      .send({
        ...OWNER_TERMS,
        name: 'Owner',
        email,
        password: PASSWORD,
        organizationName,
      });
    expect(reg.status).toBe(201);
    const sent = recorder.sentTo(email);
    const confirmed = await http()
      .post('/auth/email-verification/confirm')
      .send({ token: verificationTokenFrom(sent[sent.length - 1]) });
    expect(confirmed.status).toBe(200);
    const orgId = reg.body.organization._id as string;
    const res = await login(email, PASSWORD, orgId);
    expect(res.status).toBe(201);
    return { orgId, token: res.body.access_token as string };
  }

  /** Réinitialisation complète par le parcours public. */
  async function resetPassword(email: string, password = NEW_PASSWORD) {
    const count = resetMailsTo(email).length;
    expect((await requestReset(email)).status).toBe(202);
    const token = await nextResetToken(email, count + 1);
    const res = await confirmReset({ token, password });
    expect(res.status).toBe(200);
    return token;
  }

  function connectSocket(token: string): Promise<Socket> {
    const socket = io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 4_000,
      extraHeaders: { origin: E2E_CORS_ORIGIN },
      auth: { token },
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 5_000);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('connect_error', (err: Error) => {
        clearTimeout(timer);
        socket.close();
        reject(err);
      });
    });
  }

  function disconnected(socket: Socket): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('still connected')),
        5_000,
      );
      socket.once('disconnect', (reason: string) => {
        clearTimeout(timer);
        resolve(reason);
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
      process.env.PUBLIC_APP_URL = PUBLIC_APP_URL;

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
      productModel = moduleFixture.get(getModelToken(Product.name));
      saleModel = moduleFixture.get(getModelToken(Sale.name));
      jwtService = moduleFixture.get(JwtService);
    } catch (err) {
      await stopEphemeralMongoSafe();
      throw err;
    }
  }, 180_000);

  beforeEach(() => {
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
    emailSender.current = recorder;
    recorder.failure = null;
    recorder.configured = true;
    process.env.PUBLIC_APP_URL = PUBLIC_APP_URL;
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
    jest.restoreAllMocks();
  }, 60_000);

  describe('1. Parcours complet', () => {
    it('demande → email → réinitialisation → ancien mot de passe refusé, nouveau accepté, notification envoyée', async () => {
      const email = 'owner-1-13b@reset.test';
      const owner = await verifiedOwner(email, 'Org Reset');

      const res = await requestReset(email);
      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        message: PASSWORD_RESET_REQUEST_ACCEPTED_MESSAGE,
      });
      expect(res.headers['cache-control']).toBe('no-store');

      const token = await nextResetToken(email, 1);
      const mail = resetMailsTo(email)[0];
      expect(mail.text).toContain(
        `${PUBLIC_APP_URL}/auth/reset-password?token=${encodeURIComponent(token)}`,
      );
      expect(mail.idempotencyKey).toMatch(/^password-reset-[0-9a-f]{24}-\d+$/);
      const stored = await internals(email);
      expect(stored!.passwordResetTokenHash).toBe(sha256(token));
      const ttl = stored!.passwordResetExpiresAt!.getTime() - Date.now();
      expect(ttl).toBeGreaterThan(59 * 60_000);
      expect(ttl).toBeLessThanOrEqual(60 * 60_000);
      // Une demande ne change ni mot de passe ni session.
      expect(await bcrypt.compare(PASSWORD, stored!.password)).toBe(true);
      expect(stored!.authVersion).toBeUndefined();
      expect(
        (await http().get('/auth/context').set(auth(owner.token))).status,
      ).toBe(200);

      const confirmed = await confirmReset({ token, password: NEW_PASSWORD });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body).toEqual({ reset: true });
      expect(confirmed.headers['cache-control']).toBe('no-store');

      const after = await internals(email);
      expect(after!.authVersion).toBe(1);
      expect(after!.passwordResetTokenHash).toBeUndefined();
      expect(after!.passwordResetExpiresAt).toBeUndefined();
      expect(after!.emailVerifiedAt).toEqual(stored!.emailVerifiedAt);

      expect((await login(email, PASSWORD, owner.orgId)).status).toBe(401);
      const fresh = await login(email, NEW_PASSWORD, owner.orgId);
      expect(fresh.status).toBe(201);
      expect(
        (
          await http()
            .get('/auth/context')
            .set(auth(fresh.body.access_token as string))
        ).status,
      ).toBe(200);

      const old = await http().get('/auth/context').set(auth(owner.token));
      expect(old.status).toBe(401);
      expect(old.body.code).toBe('SESSION_REVOKED');
      expect(old.body.message).toBe(
        'Votre session a expiré. Veuillez vous reconnecter.',
      );

      await waitFor(() =>
        recorder
          .sentTo(email)
          .some((m) => m.subject === PASSWORD_CHANGED_SUBJECT),
      );
      const notice = recorder
        .sentTo(email)
        .find((m) => m.subject === PASSWORD_CHANGED_SUBJECT)!;
      expect(notice.idempotencyKey).toMatch(
        /^password-changed-[0-9a-f]{24}-1$/,
      );
      expect(notice.text + notice.html).not.toContain(NEW_PASSWORD);
      expect(notice.text + notice.html).not.toContain(token);
      expect(notice.text + notice.html).not.toContain('reset-password');
    });
  });

  describe('2. Compte inexistant et réponse neutre', () => {
    it('même réponse, aucun email', async () => {
      const bodies: unknown[] = [];
      for (const email of ['nobody-13b@reset.test', 'owner-1-13b@reset.test']) {
        const res = await requestReset(email);
        expect(res.status).toBe(202);
        bodies.push(res.body);
      }
      expect(bodies[0]).toEqual(bodies[1]);
      await settle();
      expect(recorder.sentTo('nobody-13b@reset.test')).toHaveLength(0);
    });
  });

  describe('2 bis (1-16G). Langue du destinataire', () => {
    it('compte en anglais : e-mails en anglais ; compte ancien sans préférence : français, même si la demande vient d’un navigateur anglais', async () => {
      const english = 'owner-en-16g@reset.test';
      const owner = await verifiedOwner(english, 'Boutique EN');
      const put = await http()
        .put('/auth/me/locale')
        .set(auth(owner.token))
        .send({ locale: 'en' });
      expect(put.status).toBe(200);
      await resetPassword(english);
      const resetMail = resetMailsTo(english).at(-1)!;
      expect(resetMail.subject).toBe('Reset your password – Stock Master');
      expect(resetMail.html).toContain('<html lang="en">');
      await waitFor(() =>
        recorder
          .sentTo(english)
          .some((m) => m.subject === PASSWORD_CHANGED_SUBJECT_EN),
      );
      expect(
        recorder
          .sentTo(english)
          .some((m) => m.subject === PASSWORD_CHANGED_SUBJECT),
      ).toBe(false);

      // Compte créé avant 1-16G : aucune préférence enregistrée.
      const legacy = 'owner-legacy-16g@reset.test';
      await verifiedOwner(legacy, 'Boutique ancienne');
      await userModel
        .updateOne({ email: legacy }, { $unset: { locale: 1 } })
        .exec();
      const count = resetMailsTo(legacy).length;
      const res = await http()
        .post('/auth/password-reset/request')
        .set('Accept-Language', 'en')
        .send({
          email: legacy,
          turnstileToken: simulatedTurnstileToken('password-reset'),
        });
      expect(res.status).toBe(202);
      await nextResetToken(legacy, count + 1);
      expect(resetMailsTo(legacy).at(-1)!.subject).toBe(
        'Réinitialisation de votre mot de passe – Stock Master',
      );
    });
  });

  describe('3. Compte non vérifié', () => {
    it('mot de passe changé, adresse toujours non vérifiée, connexion toujours soumise à 1-13A', async () => {
      const email = 'unverified-13b@reset.test';
      const reg = await http()
        .post('/auth/register')
        .send({
          ...OWNER_TERMS,
          name: 'Unverified',
          email,
          password: PASSWORD,
          organizationName: 'Org Unverified',
        });
      expect(reg.status).toBe(201);
      const before = await internals(email);
      await resetPassword(email);
      const after = await internals(email);
      expect(after!.emailVerifiedAt ?? null).toBeNull();
      expect(after!.emailVerificationTokenHash).toBe(
        before!.emailVerificationTokenHash,
      );
      const refused = await login(email, NEW_PASSWORD);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('EMAIL_NOT_VERIFIED');

      const verificationMail = recorder
        .sentTo(email)
        .find((m) => m.text.includes('/auth/verify-email'))!;
      expect(
        (
          await http()
            .post('/auth/email-verification/confirm')
            .send({ token: verificationTokenFrom(verificationMail) })
        ).status,
      ).toBe(200);
      expect((await login(email, NEW_PASSWORD)).status).toBe(201);
    });
  });

  describe('4. Tokens et validation', () => {
    it('absent, vide, mal typé, injection, trop long, inconnu → 400 stable', async () => {
      for (const token of [
        undefined,
        '',
        42,
        { $ne: null },
        'x'.repeat(600),
        'unknown-13b',
      ]) {
        const body: Record<string, unknown> = { password: NEW_PASSWORD };
        if (token !== undefined) body.token = token;
        const res = await confirmReset(body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PASSWORD_RESET_INVALID_OR_EXPIRED');
        expect(res.body.message).toBe(
          'Ce lien de réinitialisation est invalide ou a expiré.',
        );
      }
    });

    it('mot de passe invalide → erreur de validation distincte ; lien non consommé ; champ en trop refusé', async () => {
      const email = 'validation-13b@reset.test';
      await verifiedOwner(email, 'Org Validation');
      expect((await requestReset(email)).status).toBe(202);
      const token = await nextResetToken(email, 1);

      for (const password of ['court', 'x'.repeat(101), 123456789, undefined]) {
        const res = await confirmReset({ token, password });
        expect(res.status).toBe(400);
        expect(res.body.code).toBeUndefined();
        expect(JSON.stringify(res.body.message)).toContain(
          'Le mot de passe doit contenir entre 6 et 100 caractères.',
        );
      }
      const extra = await confirmReset({
        token,
        password: NEW_PASSWORD,
        email,
      });
      expect(extra.status).toBe(400);
      expect((await internals(email))!.passwordResetTokenHash).toBe(
        sha256(token),
      );

      // Mot de passe avec espaces de bord : jamais trimé.
      const spaced = '  espace autour  ';
      expect((await confirmReset({ token, password: spaced })).status).toBe(
        200,
      );
      expect((await login(email, spaced)).status).toBe(201);
      expect((await login(email, spaced.trim())).status).toBe(401);

      const reused = await confirmReset({ token, password: NEW_PASSWORD });
      expect(reused.status).toBe(400);
      expect(reused.body.code).toBe('PASSWORD_RESET_INVALID_OR_EXPIRED');
    });

    it('expiré → 400, mot de passe et session inchangés', async () => {
      const email = 'expired-13b@reset.test';
      const owner = await verifiedOwner(email, 'Org Expired');
      expect((await requestReset(email)).status).toBe(202);
      const token = await nextResetToken(email, 1);
      await userModel
        .updateOne(
          { email },
          { $set: { passwordResetExpiresAt: new Date(Date.now() - 1) } },
        )
        .exec();
      const res = await confirmReset({ token, password: NEW_PASSWORD });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PASSWORD_RESET_INVALID_OR_EXPIRED');
      expect((await login(email, PASSWORD, owner.orgId)).status).toBe(201);
      expect(
        (await http().get('/auth/context').set(auth(owner.token))).status,
      ).toBe(200);
    });
  });

  describe('5. Confirmations concurrentes', () => {
    it('une seule réussite, un seul changement de mot de passe et de version', async () => {
      const email = 'concurrent-13b@reset.test';
      await verifiedOwner(email, 'Org Concurrent');
      expect((await requestReset(email)).status).toBe(202);
      const token = await nextResetToken(email, 1);
      const candidates = Array.from(
        { length: 5 },
        (_, i) => `concurrent-pw-${i}!`,
      );
      const results = await Promise.all(
        candidates.map((password) => confirmReset({ token, password })),
      );
      const winners = candidates.filter((_, i) => results[i].status === 200);
      expect(winners).toHaveLength(1);
      expect(results.filter((r) => r.status === 400)).toHaveLength(4);
      const stored = await internals(email);
      expect(stored!.authVersion).toBe(1);
      expect(await bcrypt.compare(winners[0], stored!.password)).toBe(true);
      await settle();
      expect(
        recorder
          .sentTo(email)
          .filter((m) => m.subject === PASSWORD_CHANGED_SUBJECT),
      ).toHaveLength(1);
    });
  });

  describe('6. Demandes : concurrence, cooldown, plafond, remplacement, limites', () => {
    it('demandes concurrentes → un envoi ; cooldown ; remplacement du lien ; demande après réinitialisation', async () => {
      const email = 'requests-13b@reset.test';
      await verifiedOwner(email, 'Org Requests');
      const results = await Promise.all(
        Array.from({ length: 5 }, () => requestReset(email)),
      );
      expect(results.map((r) => r.status)).toEqual([202, 202, 202, 202, 202]);
      await settle();
      expect(resetMailsTo(email)).toHaveLength(1);
      const first = await nextResetToken(email, 1);
      // Les 5 demandes ont atteint la limite par adresse (attendu) : remise à
      // zéro du stockage de limitation pour la suite du scénario.
      moduleFixture.get(ThrottlerStorage).onApplicationShutdown();

      expect((await requestReset(email)).status).toBe(202);
      await settle();
      expect(resetMailsTo(email)).toHaveLength(1); // cooldown

      await expireCooldown(email);
      expect((await requestReset(email)).status).toBe(202);
      const second = await nextResetToken(email, 2);
      expect(second).not.toBe(first);
      const keys = resetMailsTo(email).map((m) => m.idempotencyKey);
      expect(new Set(keys).size).toBe(2);
      expect(
        (await confirmReset({ token: first, password: NEW_PASSWORD })).status,
      ).toBe(400);
      expect(
        (await confirmReset({ token: second, password: NEW_PASSWORD })).status,
      ).toBe(200);

      // Après réinitialisation (version 1) : une nouvelle demande fonctionne.
      await expireCooldown(email);
      expect((await requestReset(email)).status).toBe(202);
      const third = await nextResetToken(email, 3);
      expect(
        (await confirmReset({ token: third, password: 'third-pw-13b!' }))
          .status,
      ).toBe(200);
      expect((await internals(email))!.authVersion).toBe(2);
    });

    it('plafond horaire par compte : aucun envoi au-delà', async () => {
      const email = 'cap-13b@reset.test';
      await verifiedOwner(email, 'Org Cap');
      await userModel
        .updateOne(
          { email },
          {
            $set: {
              passwordResetLastSentAt: new Date(Date.now() - 120_000),
              passwordResetWindowStartedAt: new Date(Date.now() - 600_000),
              passwordResetSendCount: 5,
            },
          },
        )
        .exec();
      expect((await requestReset(email)).status).toBe(202);
      await settle();
      expect(resetMailsTo(email)).toHaveLength(0);
    });

    it('limite par adresse normalisée : 429 au-delà de 5, namespace distinct de la vérification', async () => {
      const statuses: number[] = [];
      for (const variant of [
        'limit-13b@reset.test',
        'Limit-13b@reset.test',
        ' limit-13b@RESET.test ',
        'limit-13b@reset.test',
        'limit-13b@reset.test',
        'limit-13b@reset.test',
      ]) {
        const res = await requestReset(variant);
        statuses.push(res.status);
        if (res.status === 429) {
          expect(res.body.code).toBe('PASSWORD_RESET_RATE_LIMITED');
          expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
          expect(JSON.stringify(res.body)).not.toContain('limit-13b');
        }
      }
      expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
      const verification = await http()
        .post('/auth/email-verification/request')
        .send({
          email: 'limit-13b@reset.test',
          turnstileToken: simulatedTurnstileToken('email-verification'),
        });
      expect(verification.status).toBe(202);
    });
  });

  describe('7. Configuration absente et échecs Resend', () => {
    let fetchMock: jest.SpyInstance;
    const resend = (env: Record<string, string | undefined>) =>
      new ResendEmailSender({
        get: (key: string) => env[key],
      } as unknown as ConfigService);

    beforeEach(() => {
      fetchMock = jest.spyOn(global, 'fetch');
      fetchMock.mockRejectedValue(new Error('unexpected real fetch'));
    });
    afterEach(() => fetchMock.mockRestore());

    it('configuration absente → 503 identique pour toute adresse, sans appel réseau ni effet', async () => {
      const email = 'noconfig-13b@reset.test';
      const owner = await verifiedOwner(email, 'Org NoConfig');
      emailSender.current = resend({ EMAIL_FROM: 'no-reply@reset.test' });
      const known = await requestReset(email);
      const unknown = await requestReset('nobody-noconfig-13b@reset.test');
      for (const res of [known, unknown]) {
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('EMAIL_DELIVERY_UNAVAILABLE');
      }
      expect(known.body).toEqual({
        ...unknown.body,
        path: known.body.path,
        timestamp: known.body.timestamp,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await internals(email))!.passwordResetTokenHash).toBeUndefined();
      expect(
        (await http().get('/auth/context').set(auth(owner.token))).status,
      ).toBe(200);
    });

    it.each([
      [
        'refus (HTTP 422)',
        () => Promise.resolve(new Response('{}', { status: 422 })),
      ],
      [
        'timeout',
        () =>
          Promise.reject(
            Object.assign(new Error('t'), { name: 'TimeoutError' }),
          ),
      ],
    ])(
      'Resend %s → réponse neutre, mot de passe et sessions inchangés',
      async (_l, behaviour) => {
        const email = `fail-${randomUUID().slice(0, 8)}-13b@reset.test`;
        const owner = await verifiedOwner(email, 'Org Fail');
        emailSender.current = resend({
          RESEND_API_KEY: 're_e2e_fake',
          EMAIL_FROM: 'Stock Master <no-reply@reset.test>',
        });
        fetchMock.mockImplementation(behaviour);
        const res = await requestReset(email);
        expect(res.status).toBe(202);
        expect(res.body).toEqual({
          message: PASSWORD_RESET_REQUEST_ACCEPTED_MESSAGE,
        });
        await waitFor(() => fetchMock.mock.calls.length === 1);
        await settle();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(
          (init.headers as Record<string, string>)['Idempotency-Key'],
        ).toMatch(/^password-reset-/);
        const stored = await internals(email);
        expect(await bcrypt.compare(PASSWORD, stored!.password)).toBe(true);
        expect(stored!.authVersion).toBeUndefined();
        // Échec ambigu : lien réservé conservé jusqu'à expiration/remplacement.
        expect(stored!.passwordResetTokenHash).toMatch(/^[0-9a-f]{64}$/);
        expect(
          (await http().get('/auth/context').set(auth(owner.token))).status,
        ).toBe(200);
      },
    );
  });

  describe('8 + 9 + 10. Sessions, sockets et ventes en attente', () => {
    it('anciens JWT (deux organisations + historique sans version) refusés ; sockets fermés ; autre utilisateur intact ; vente rejouée une seule fois', async () => {
      const email = 'multi-13b@reset.test';
      const a = await verifiedOwner(email, 'Org Multi A');
      const other = await verifiedOwner('other-13b@reset.test', 'Org Multi B');
      // A rejoint l'organisation B par invitation (compte existant).
      const inv = await http()
        .post('/organizations/invitations')
        .set(auth(other.token))
        .send({ email, role: 'seller' });
      expect(inv.status).toBe(201);
      const invToken = new URL(
        inv.body.invitationUrl as string,
      ).searchParams.get('token');
      // 1-18B : compte existant → session de ce compte et accord explicite.
      expect(
        (await acceptWithSession(app.getHttpServer(), a.token, invToken!))
          .status,
      ).toBe(200);
      const aInB = (await login(email, PASSWORD, other.orgId)).body
        .access_token as string;
      const userId = (await internals(email))!._id.toString();
      // JWT historique (antérieur à 1-13B) : aucun claim `ver`.
      const legacy = jwtService.sign({ sub: userId, orgId: a.orgId });
      for (const token of [a.token, aInB, legacy]) {
        expect(
          (await http().get('/auth/context').set(auth(token))).status,
        ).toBe(200);
      }

      const sockets = [
        await connectSocket(a.token),
        await connectSocket(aInB),
        await connectSocket(legacy),
      ];
      const otherSocket = await connectSocket(other.token);
      const closing = sockets.map(disconnected);

      // Vente en attente préparée côté appareil (outbox).
      const sectionRes = await http()
        .post('/sections')
        .set(auth(a.token))
        .send({ name: 'Rayon 13B' });
      const product = await productModel.create({
        organizationId: new Types.ObjectId(a.orgId),
        sectionId: new Types.ObjectId(sectionRes.body._id as string),
        name: 'Produit 13B',
        imageUrl: 'https://e2e.local/img.png',
        purchasePrice: 100,
        salePrice: 300,
        initialQuantity: 10,
        remainingQuantity: 10,
      });
      const pending = {
        productId: product._id.toString(),
        quantity: 1,
        salePrice: 300,
        clientOperationId: randomUUID(),
        occurredAt: new Date().toISOString(),
      };

      await resetPassword(email);

      expect(await Promise.all(closing)).toEqual([
        'io server disconnect',
        'io server disconnect',
        'io server disconnect',
      ]);
      expect(otherSocket.connected).toBe(true);
      expect(
        (await http().get('/auth/context').set(auth(other.token))).status,
      ).toBe(200);

      for (const token of [a.token, aInB, legacy]) {
        for (const path of ['/auth/context', '/auth/me', '/products']) {
          const res = await http().get(path).set(auth(token));
          expect(res.status).toBe(401);
          expect(res.body.code).toBe('SESSION_REVOKED');
        }
        const switched = await http()
          .post('/auth/switch-organization')
          .set(auth(token))
          .send({ organizationId: other.orgId });
        expect(switched.status).toBe(401);
        await expect(connectSocket(token)).rejects.toThrow('unauthorized');
      }

      const blocked = await http()
        .post('/sales')
        .set(auth(a.token))
        .send(pending);
      expect(blocked.status).toBe(401);
      expect(blocked.body.code).toBe('SESSION_REVOKED');
      expect(
        await saleModel.countDocuments({
          organizationId: new Types.ObjectId(a.orgId),
        }),
      ).toBe(0);

      const fresh = (await login(email, NEW_PASSWORD, a.orgId)).body
        .access_token as string;
      const freshSocket = await connectSocket(fresh);
      // Les connexions à la nouvelle version sont préservées.
      moduleFixture
        .get(SocketRegistryService)
        .disconnectUserSessionsBefore(userId, 1);
      await settle();
      expect(freshSocket.connected).toBe(true);
      const switchedFresh = await http()
        .post('/auth/switch-organization')
        .set(auth(fresh))
        .send({ organizationId: other.orgId });
      expect(switchedFresh.status).toBe(200);
      expect(
        (
          await http()
            .get('/auth/context')
            .set(auth(switchedFresh.body.access_token as string))
        ).status,
      ).toBe(200);

      const replayed = await http()
        .post('/sales')
        .set(auth(fresh))
        .send(pending);
      expect(replayed.status).toBe(201);
      const again = await http().post('/sales').set(auth(fresh)).send(pending);
      expect(again.body._id).toBe(replayed.body._id);
      expect(
        await saleModel.countDocuments({
          organizationId: new Types.ObjectId(a.orgId),
        }),
      ).toBe(1);

      freshSocket.close();
      otherSocket.close();
    });
  });

  describe('11. Aucune fuite', () => {
    it('réponses et journaux sans token, hash ni champ interne', async () => {
      const email = 'leak-13b@reset.test';
      await verifiedOwner(email, 'Org Leak');
      await resetPassword(email);
      const res = await login(email, NEW_PASSWORD);
      const token = res.body.access_token as string;
      const responses = [
        res.body,
        (await http().get('/auth/me').set(auth(token))).body,
        (await http().get('/organizations/current/members').set(auth(token)))
          .body,
        (await http().get('/auth/context').set(auth(token))).body,
      ];
      for (const body of responses) {
        expect(JSON.stringify(body)).not.toMatch(
          /authVersion|passwordReset|emailVerificationTokenHash|"password"/,
        );
      }
      const allLogs = logs.join('\n');
      for (const secret of [...seenTokens, ...[...seenTokens].map(sha256)]) {
        expect(allLogs).not.toContain(secret);
      }
      expect(allLogs).not.toContain('/auth/reset-password');
      expect(allLogs).not.toContain(NEW_PASSWORD);
      for (const line of logs.filter((l) => l.startsWith('[PasswordReset]'))) {
        expect(line).not.toContain('@');
      }
    });
  });
  describe('12. Compte historique et opérations concurrentes', () => {
    /**
     * Suspend le PROCHAIN appel à `resolveActiveContext` (connexion avec
     * organisation choisie, changement d'organisation) entre la lecture de
     * l'état et l'émission du JWT. Aucun sleep : barrière explicite.
     */
    function suspendNextContextResolution() {
      const organizations = moduleFixture.get(OrganizationsService);
      const original = organizations.resolveActiveContext.bind(organizations);
      const barrier = makeBarrier();
      const spy = jest
        .spyOn(organizations, 'resolveActiveContext')
        .mockImplementationOnce(async (...args) => {
          barrier.signal();
          await barrier.released;
          return original(...args);
        });
      return { barrier, spy };
    }

    async function joinSecondOrganization(
      email: string,
      inviterToken: string,
      inviteeToken: string,
    ) {
      const inv = await http()
        .post('/organizations/invitations')
        .set(auth(inviterToken))
        .send({ email, role: 'seller' });
      expect(inv.status).toBe(201);
      const token = new URL(inv.body.invitationUrl as string).searchParams.get(
        'token',
      );
      expect(
        (await acceptWithSession(app.getHttpServer(), inviteeToken, token!))
          .status,
      ).toBe(200);
    }

    it('compte historique réel : authVersion retiré par $unset, absent en lecture brute, réservation et confirmation sans migration', async () => {
      const email = 'historic-13b@reset.test';
      const owner = await verifiedOwner(email, 'Org Historic');
      const userId = (await internals(email))!._id;
      await userModel.collection.updateOne(
        { _id: userId },
        { $unset: { authVersion: '' } },
      );
      const raw = () => userModel.collection.findOne({ _id: userId });
      expect(Object.keys((await raw())!)).not.toContain('authVersion');

      // JWT antérieur à 1-13B : aucun claim `ver`.
      const legacy = jwtService.sign({
        sub: userId.toString(),
        orgId: owner.orgId,
      });
      expect('ver' in claimsOf(legacy)).toBe(false);
      expect(claimsOf(owner.token).ver).toBe(0);
      for (const token of [legacy, owner.token]) {
        expect(
          (await http().get('/auth/context').set(auth(token))).status,
        ).toBe(200);
      }

      expect((await requestReset(email)).status).toBe(202);
      const token = await nextResetToken(email, 1);
      const reserved = (await raw())!;
      expect(reserved.passwordResetTokenHash).toBe(sha256(token));
      expect(Object.keys(reserved)).not.toContain('authVersion');

      const confirmed = await confirmReset({ token, password: NEW_PASSWORD });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body).toEqual({ reset: true });
      expect((await raw())!.authVersion).toBe(1);

      expect((await login(email, NEW_PASSWORD, owner.orgId)).status).toBe(201);
      expect((await login(email, PASSWORD, owner.orgId)).status).toBe(401);
      for (const old of [legacy, owner.token]) {
        const res = await http().get('/auth/context').set(auth(old));
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('SESSION_REVOKED');
      }
    });

    it('connexion suspendue après lecture des anciens identifiants, réinitialisation, reprise : jamais de session utilisable', async () => {
      const email = 'race-login-13b@reset.test';
      const owner = await verifiedOwner(email, 'Org Race Login');
      const { barrier, spy } = suspendNextContextResolution();
      try {
        // Lancement effectif de la requête (supertest est paresseux).
        const pending = login(email, PASSWORD, owner.orgId).then((r) => r);
        await barrier.reached; // identifiants anciens lus et validés
        await resetPassword(email);
        barrier.release();
        const res = await pending;

        // Issue déterministe : identifiants validés avant la réinitialisation,
        // JWT signé avec la version lue à ce moment (0) — donc refusé.
        expect(res.status).toBe(201);
        const jwt = res.body.access_token as string;
        expect(claimsOf(jwt).ver).toBe(0);
        for (const path of ['/auth/context', '/auth/me', '/products']) {
          const context = await http().get(path).set(auth(jwt));
          expect(context.status).toBe(401);
          expect(context.body.code).toBe('SESSION_REVOKED');
        }
        const derived = await http()
          .post('/auth/switch-organization')
          .set(auth(jwt))
          .send({ organizationId: owner.orgId });
        expect(derived.status).toBe(401);
        await expect(connectSocket(jwt)).rejects.toThrow('unauthorized');
      } finally {
        spy.mockRestore();
      }
      const fresh = await login(email, NEW_PASSWORD, owner.orgId);
      expect(fresh.status).toBe(201);
      expect(claimsOf(fresh.body.access_token as string).ver).toBe(1);
      expect(
        (
          await http()
            .get('/auth/context')
            .set(auth(fresh.body.access_token as string))
        ).status,
      ).toBe(200);
    });

    it('changement d organisation suspendu (ancien JWT), réinitialisation, reprise : aucun JWT utilisable ; choix d organisation normal préservé', async () => {
      const email = 'race-switch-13b@reset.test';
      const a = await verifiedOwner(email, 'Org Race Switch A');
      const b = await verifiedOwner(
        'race-switch-b-13b@reset.test',
        'Org Race Switch B',
      );
      await joinSecondOrganization(email, b.token, a.token);

      // Fonctionnement normal avant toute réinitialisation.
      const normal = await http()
        .post('/auth/switch-organization')
        .set(auth(a.token))
        .send({ organizationId: b.orgId });
      expect(normal.status).toBe(200);
      const normalCtx = await http()
        .get('/auth/context')
        .set(auth(normal.body.access_token as string));
      expect(normalCtx.status).toBe(200);
      expect(normalCtx.body.organizationId).toBe(b.orgId);

      const { barrier, spy } = suspendNextContextResolution();
      try {
        const pending = http()
          .post('/auth/switch-organization')
          .set(auth(a.token))
          .send({ organizationId: b.orgId })
          .then((r) => r);
        await barrier.reached; // ancien JWT déjà accepté par la stratégie
        await resetPassword(email);
        barrier.release();
        const res = await pending;

        // Issue déterministe : la version validée du JWT appelant (0) ne
        // correspond plus à la base (1) → refus, aucun JWT émis.
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('SESSION_REVOKED');
        expect(res.body.access_token).toBeUndefined();
      } finally {
        spy.mockRestore();
      }

      // Après réinitialisation : connexion puis choix d'organisation normal.
      const fresh = (await login(email, NEW_PASSWORD, a.orgId)).body
        .access_token as string;
      const switched = await http()
        .post('/auth/switch-organization')
        .set(auth(fresh))
        .send({ organizationId: b.orgId });
      expect(switched.status).toBe(200);
      expect(claimsOf(switched.body.access_token as string).ver).toBe(1);
      const ctx = await http()
        .get('/auth/context')
        .set(auth(switched.body.access_token as string));
      expect(ctx.status).toBe(200);
      expect(ctx.body.organizationId).toBe(b.orgId);
    });
  });
});
