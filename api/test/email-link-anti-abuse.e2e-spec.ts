import 'reflect-metadata';
import { Model } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument } from './../src/users/schemas/user.schema';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import {
  EMAIL_VERIFICATION_ADDRESS_THROTTLER,
  hashedAddressKey,
} from '../src/email-verification/email-verification-rate-limiting';
import { PASSWORD_RESET_ADDRESS_THROTTLER } from '../src/password-reset/password-reset-rate-limiting';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import {
  E2E_EMAIL_VERIFIED_AT,
  RecordingEmailSender,
} from './e2e/email-verification-fixtures';
import { simulatedTurnstileToken } from './e2e/legal-acceptance-fixtures';
import { resetAuthRateLimits } from './e2e/rate-limit-fixtures';

/**
 * E2E 1-18D — vérification anti-robot des demandes de liens
 * (`password-reset/request`, `email-verification/request`) sur
 * l'application réelle (gardes, pipes, filtre), MongoDB éphémère,
 * Turnstile SIMULÉ et e-mails enregistrés (aucun fournisseur réel).
 */
const recorder = new RecordingEmailSender();
const PASSWORD = 'email-link-18d-pw-!1x';
const HIDDEN_FIELDS =
  '+emailVerificationTokenHash +emailVerificationExpiresAt +emailVerificationLastSentAt +emailVerificationWindowStartedAt +emailVerificationSendCount +passwordResetTokenHash +passwordResetExpiresAt +passwordResetLastSentAt +passwordResetWindowStartedAt +passwordResetSendCount +authVersion';

type Route = {
  label: string;
  path: string;
  action: string;
  namespace: string;
  rateLimitCode: string;
  /** Compte qui reçoit un e-mail sur demande valide. */
  verified: boolean;
};

const ROUTES: Route[] = [
  {
    label: 'vérification d’e-mail',
    path: '/auth/email-verification/request',
    action: 'email-verification',
    namespace: EMAIL_VERIFICATION_ADDRESS_THROTTLER,
    rateLimitCode: 'EMAIL_VERIFICATION_RATE_LIMITED',
    verified: false,
  },
  {
    label: 'réinitialisation',
    path: '/auth/password-reset/request',
    action: 'password-reset',
    namespace: PASSWORD_RESET_ADDRESS_THROTTLER,
    rateLimitCode: 'PASSWORD_RESET_RATE_LIMITED',
    verified: true,
  },
];

describe('Anti-robot des demandes de liens (e2e 1-18D)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let userModel: Model<UserDocument>;

  const server = () => app.getHttpServer();
  const send = (route: Route, email: string, token?: string) =>
    request(server())
      .post(route.path)
      .send({
        email,
        ...(token === undefined ? {} : { turnstileToken: token }),
      });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
  /** Quota d'adresse (stockage du throttler) : `undefined` = jamais consommé. */
  const quotaHits = (route: Route, email: string) => {
    const memory: {
      storage: Map<string, { totalHits: Map<string, number> }>;
    } = moduleFixture.get(ThrottlerStorage);
    return memory.storage
      .get(hashedAddressKey(route.namespace, email))
      ?.totalHits.get(route.namespace);
  };
  const snapshot = (email: string) =>
    userModel.findOne({ email }).select(HIDDEN_FIELDS).lean().exec();

  let seq = 0;
  async function account(route: Route) {
    seq += 1;
    const email = `link-${seq}-${Date.now()}@email-link.test`;
    await userModel.create({
      ...(route.verified ? { emailVerifiedAt: E2E_EMAIL_VERIFIED_AT } : {}),
      name: `Compte ${seq}`,
      email,
      password: await bcrypt.hash(PASSWORD, 10),
    });
    return email;
  }

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = 'email-link-18d-e2e-only-secret';
      process.env.S3_ENDPOINT = 'http://127.0.0.1:65535';
      process.env.S3_REGION = 'us-east-1';
      process.env.S3_ACCESS_KEY = 'e2e-local';
      process.env.S3_SECRET_KEY = 'e2e-local';
      process.env.S3_BUCKET = 'e2e-local';
      process.env.S3_FORCE_PATH_STYLE = 'true';
      process.env.CORS_ORIGIN = 'https://email-link-e2e.example.com';
      process.env.PUBLIC_APP_URL = 'https://app.email-link-e2e.test';
      process.env.TURNSTILE_SIMULATED = 'true';
      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(recorder)
        .compile();
      app = moduleFixture.createNestApplication();
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
    } catch (error) {
      if (moduleFixture) await moduleFixture.close().catch(() => undefined);
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  afterAll(async () => {
    process.env.TURNSTILE_SIMULATED = 'true';
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  beforeEach(async () => {
    process.env.TURNSTILE_SIMULATED = 'true';
    recorder.reset();
    await resetAuthRateLimits(moduleFixture);
  });

  describe.each(ROUTES)('$label', (route) => {
    it.each([
      ['défi absent', undefined, 400, 'TURNSTILE_REQUIRED'],
      ['défi invalide', 'not-a-valid-token', 400, 'TURNSTILE_FAILED'],
      ['défi d’une autre action', 'other-action', 400, 'TURNSTILE_FAILED'],
      [
        'fournisseur indisponible',
        'simulated-unavailable',
        503,
        'TURNSTILE_UNAVAILABLE',
      ],
    ])(
      '%s → %s : aucune écriture, aucun quota d’adresse, aucun e-mail',
      async (_label, token, status, code) => {
        const email = await account(route);
        const before = await snapshot(email);
        const res = await send(
          route,
          email,
          token === 'other-action'
            ? simulatedTurnstileToken(
                route.action === 'password-reset'
                  ? 'email-verification'
                  : 'password-reset',
              )
            : token,
        );
        expect(res.status).toBe(status);
        expect(res.body.code).toBe(code);
        await settle();
        expect(await snapshot(email)).toEqual(before);
        expect(quotaHits(route, email)).toBeUndefined();
        expect(recorder.sentTo(email)).toHaveLength(0);
      },
    );

    it('défi rejoué : refusé, quota et jetons inchangés depuis la demande valide', async () => {
      const email = await account(route);
      const token = simulatedTurnstileToken(route.action);
      expect((await send(route, email, token)).status).toBe(202);
      await settle();
      const after = await snapshot(email);
      expect(recorder.sentTo(email)).toHaveLength(1);
      const replay = await send(route, email, token);
      expect([replay.status, replay.body.code]).toEqual([
        400,
        'TURNSTILE_FAILED',
      ]);
      await settle();
      expect(await snapshot(email)).toEqual(after);
      expect(quotaHits(route, email)).toBe(1);
      expect(recorder.sentTo(email)).toHaveLength(1);
    });

    it('Turnstile non configuré : 503 réessayable, rien consommé', async () => {
      delete process.env.TURNSTILE_SIMULATED;
      const email = await account(route);
      const before = await snapshot(email);
      const res = await send(
        route,
        email,
        simulatedTurnstileToken(route.action),
      );
      expect([res.status, res.body.code]).toEqual([
        503,
        'TURNSTILE_UNAVAILABLE',
      ]);
      await settle();
      expect(await snapshot(email)).toEqual(before);
      expect(quotaHits(route, email)).toBeUndefined();
    });

    it('défi valide : réponse neutre identique (compte concerné, inconnu, autre état)', async () => {
      const target = await account(route);
      const other = await account({ ...route, verified: !route.verified });
      const unknown = `unknown-${Date.now()}@email-link.test`;
      const bodies = [];
      for (const email of [target, other, unknown]) {
        const res = await send(
          route,
          email,
          simulatedTurnstileToken(route.action),
        );
        expect(res.status).toBe(202);
        bodies.push(res.body);
      }
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
      await settle();
      expect(recorder.sentTo(target)).toHaveLength(1);
      expect(recorder.sentTo(unknown)).toHaveLength(0);
      // Vérification : un compte déjà vérifié ne reçoit rien ; la
      // réinitialisation, elle, concerne tout compte existant.
      expect(recorder.sentTo(other)).toHaveLength(
        route.action === 'password-reset' ? 1 : 0,
      );
    });

    it('défis valides : délai entre envois et plafond d’adresse toujours appliqués, jamais remis à zéro', async () => {
      const email = await account(route);
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        statuses.push(
          (await send(route, email, simulatedTurnstileToken(route.action)))
            .status,
        );
      }
      expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
      await settle();
      // Délai de 60 s : un seul e-mail malgré cinq demandes acceptées.
      expect(recorder.sentTo(email)).toHaveLength(1);
      const again = await send(
        route,
        email,
        simulatedTurnstileToken(route.action),
      );
      expect([again.status, again.body.code]).toEqual([
        429,
        route.rateLimitCode,
      ]);
      expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('demandes concurrentes : plafond d’adresse et envoi unique respectés', async () => {
      const email = await account(route);
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          send(route, email, simulatedTurnstileToken(route.action)),
        ),
      );
      const statuses = responses.map((r) => r.status).sort();
      expect(statuses).toEqual([202, 202, 202, 202, 202, 429, 429, 429]);
      await settle();
      expect(recorder.sentTo(email)).toHaveLength(1);
      const stored = await snapshot(email);
      const count =
        route.action === 'password-reset'
          ? stored!.passwordResetSendCount
          : stored!.emailVerificationSendCount;
      expect(count).toBe(1);
    });
  });
});
