import 'reflect-metadata';
import { Connection, Model } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument } from './../src/users/schemas/user.schema';
import { UsersService } from './../src/users/users.service';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import { REGISTRATION_ACCEPTED_MESSAGE } from '../src/auth/auth.service';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import {
  E2E_EMAIL_VERIFIED_AT,
  RecordingEmailSender,
  verificationTokenFrom,
} from './e2e/email-verification-fixtures';
import {
  legalAcceptanceFor,
  simulatedTurnstileToken,
} from './e2e/legal-acceptance-fixtures';
import { LegalAcceptanceContext } from '../src/legal/legal-documents';
import { LEGAL_ACCEPTANCES_COLLECTION } from '../src/legal/schemas/legal-acceptance.schema';
import { postRegister } from './e2e/registration-fixtures';
import { resetAuthRateLimits } from './e2e/rate-limit-fixtures';

/**
 * E2E 1-18E — l'inscription publique ne révèle pas l'existence d'un compte :
 * même 202 et même corps pour une adresse nouvelle, existante vérifiée ou
 * existante non vérifiée ; aucune écriture pour une adresse existante.
 * Application réelle, MongoDB éphémère, Turnstile simulé, e-mails enregistrés.
 */
const recorder = new RecordingEmailSender();
const PASSWORD = 'registration-18e-pw-!1x';
const OWNER_LEGAL = legalAcceptanceFor(
  LegalAcceptanceContext.OWNER_REGISTRATION,
);

describe('Confidentialité de l’inscription publique (e2e 1-18E)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let userModel: Model<UserDocument>;
  let organizationModel: Model<OrganizationDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;

  let seq = 0;
  const unique = (label: string) => {
    seq += 1;
    return `${label}-${seq}-${Date.now()}@privacy.test`;
  };
  const body = (email: string, extra: Record<string, unknown> = {}) => ({
    name: 'Inscrit',
    email,
    password: PASSWORD,
    organizationName: `Org ${seq}`.slice(0, 20),
    legalAcceptance: OWNER_LEGAL,
    turnstileToken: simulatedTurnstileToken(),
    ...extra,
  });
  /** Corps public sans champs variables (aucun dans ce contrat). */
  const publicView = (res: request.Response) => ({
    status: res.status,
    body: res.body as unknown,
    cacheControl: res.headers['cache-control'],
  });
  const legalProofs = () =>
    moduleFixture
      .get<Connection>(getConnectionToken())
      .collection(LEGAL_ACCEPTANCES_COLLECTION)
      .countDocuments();
  /** Compte existant (vérifié ou non), membre propriétaire d'une organisation. */
  async function existingAccount(verified: boolean) {
    const email = unique(verified ? 'verified' : 'unverified');
    const res = await postRegister(app, body(email));
    expect(res.status).toBe(202);
    if (verified) {
      await userModel.updateOne(
        { email },
        { $set: { emailVerifiedAt: E2E_EMAIL_VERIFIED_AT } },
      );
    }
    recorder.reset();
    return email;
  }
  async function snapshot(email: string) {
    const user = await userModel
      .findOne({ email })
      .select(
        '+password +authVersion +emailVerificationTokenHash +emailVerificationExpiresAt +emailVerificationLastSentAt +emailVerificationWindowStartedAt +emailVerificationSendCount',
      )
      .lean()
      .exec();
    const memberships = await membershipModel
      .find({ userId: user!._id })
      .lean()
      .exec();
    return { user, memberships };
  }

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = 'registration-18e-e2e-only-secret';
      process.env.S3_ENDPOINT = 'http://127.0.0.1:65535';
      process.env.S3_REGION = 'us-east-1';
      process.env.S3_ACCESS_KEY = 'e2e-local';
      process.env.S3_SECRET_KEY = 'e2e-local';
      process.env.S3_BUCKET = 'e2e-local';
      process.env.S3_FORCE_PATH_STYLE = 'true';
      process.env.CORS_ORIGIN = 'https://privacy-e2e.example.com';
      process.env.PUBLIC_APP_URL = 'https://app.privacy-e2e.test';
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
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
      organizationModel = moduleFixture.get(getModelToken(Organization.name));
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );
    } catch (error) {
      if (moduleFixture) await moduleFixture.close().catch(() => undefined);
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  beforeEach(async () => {
    process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
    process.env.TURNSTILE_SIMULATED = 'true';
    recorder.reset();
    await resetAuthRateLimits(moduleFixture);
  });

  it('adresse nouvelle, existante vérifiée, existante non vérifiée : même statut, même corps, même en-tête', async () => {
    const verified = await existingAccount(true);
    const unverified = await existingAccount(false);
    const views: ReturnType<typeof publicView>[] = [];
    for (const email of [unique('new'), verified, unverified]) {
      views.push(publicView(await postRegister(app, body(email))));
    }
    expect(views[0]).toEqual({
      status: 202,
      body: { message: REGISTRATION_ACCEPTED_MESSAGE },
      cacheControl: 'no-store',
    });
    expect(views[1]).toEqual(views[0]);
    expect(views[2]).toEqual(views[0]);
    expect(JSON.stringify(views)).not.toMatch(/_id|token|organization/i);
  });

  it.each([true, false])(
    'compte existant (vérifié : %s) : données, adhésions et preuves strictement inchangées ; ni organisation ni e-mail',
    async (verified) => {
      const email = await existingAccount(verified);
      const before = await snapshot(email);
      const organizations = await organizationModel.countDocuments();
      const proofs = await legalProofs();
      const res = await postRegister(
        app,
        body(email.toUpperCase(), {
          name: 'Autre Nom',
          password: 'another-password-!1x',
          organizationName: 'Org Intruse',
        }),
      );
      expect(res.status).toBe(202);
      expect(await snapshot(email)).toEqual(before);
      expect(await organizationModel.countDocuments()).toBe(organizations);
      expect(
        await organizationModel.countDocuments({ name: 'Org Intruse' }),
      ).toBe(0);
      expect(await legalProofs()).toBe(proofs);
      expect(recorder.sentTo(email)).toHaveLength(0);
      // L'ancien mot de passe reste le seul valable.
      const stored = await userModel
        .findOne({ email })
        .select('+password')
        .exec();
      await expect(bcrypt.compare(PASSWORD, stored!.password)).resolves.toBe(
        true,
      );
    },
  );

  it('nouvelle inscription : compte, organisation, preuve et lien envoyé après la réponse ; vérification puis connexion', async () => {
    const email = unique('fresh');
    const proofs = await legalProofs();
    const res = await postRegister(app, body(email));
    expect(res.status).toBe(202);
    expect(res.owner).toBeDefined();
    expect(await legalProofs()).toBe(proofs + 1);
    const sent = recorder.sentTo(email);
    expect(sent).toHaveLength(1);
    const confirmed = await request(app.getHttpServer())
      .post('/auth/email-verification/confirm')
      .send({ token: verificationTokenFrom(sent[0]) });
    expect(confirmed.status).toBe(200);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    expect(login.status).toBe(201);
  });

  it('inscriptions concurrentes à la même adresse : une seule création, aucun orphelin, réponses neutres identiques', async () => {
    const email = unique('race');
    const organizationName = `Race ${seq}`;
    const proofs = await legalProofs();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        postRegister(app, body(email, { organizationName })),
      ),
    );
    for (const res of responses) {
      expect(publicView(res)).toEqual(publicView(responses[0]));
      expect(res.status).toBe(202);
    }
    expect(await userModel.countDocuments({ email })).toBe(1);
    expect(
      await organizationModel.countDocuments({ name: organizationName }),
    ).toBe(1);
    const user = await userModel.findOne({ email }).exec();
    expect(await membershipModel.countDocuments({ userId: user!._id })).toBe(1);
    expect(await legalProofs()).toBe(proofs + 1);
    expect(recorder.sentTo(email)).toHaveLength(1);
  }, 30_000);

  it('validations conservées, identiques pour une adresse nouvelle ou existante', async () => {
    const existing = await existingAccount(true);
    for (const email of [unique('invalid'), existing]) {
      const noLegal = await postRegister(
        app,
        body(email, { legalAcceptance: undefined }),
      );
      expect([noLegal.status, noLegal.body.code]).toEqual([
        400,
        'LEGAL_ACCEPTANCE_REQUIRED',
      ]);
      const tooLong = await postRegister(
        app,
        body(email, { name: 'x'.repeat(21) }),
      );
      expect(tooLong.status).toBe(400);
      const forbidden = await postRegister(app, body(email, { role: 'owner' }));
      expect(forbidden.status).toBe(400);
    }
    const badEmail = await postRegister(app, body('not-an-email'));
    expect(badEmail.status).toBe(400);
  });

  it('anti-robot et ouverture : refus identiques quelle que soit l’adresse, rien écrit', async () => {
    const existing = await existingAccount(true);
    const fresh = unique('bot');
    for (const email of [fresh, existing]) {
      const noToken = await postRegister(
        app,
        body(email, { turnstileToken: undefined }),
      );
      expect([noToken.status, noToken.body.code]).toEqual([
        400,
        'TURNSTILE_REQUIRED',
      ]);
      const bad = await postRegister(
        app,
        body(email, { turnstileToken: 'nope' }),
      );
      expect([bad.status, bad.body.code]).toEqual([400, 'TURNSTILE_FAILED']);
    }
    delete process.env.PUBLIC_REGISTRATION_ENABLED;
    const closed = await postRegister(app, body(fresh));
    expect([closed.status, closed.body.code]).toEqual([
      403,
      'REGISTRATION_DISABLED',
    ]);
    expect(await userModel.countDocuments({ email: fresh })).toBe(0);
  });

  it('erreurs techniques jamais masquées : base indisponible (lecture ou création) → 500, aucune écriture', async () => {
    const users = moduleFixture.get(UsersService);
    const read = jest
      .spyOn(users, 'findByEmail')
      .mockRejectedValueOnce(new Error('simulated database outage'));
    const failedRead = await postRegister(app, body(unique('outage-read')));
    expect(failedRead.status).toBeGreaterThanOrEqual(500);
    read.mockRestore();

    const email = unique('outage-write');
    const create = organizationModel.create.bind(organizationModel) as (
      docs: unknown,
      opts?: { session?: unknown },
    ) => Promise<unknown>;
    organizationModel.create = ((
      docs: unknown,
      opts?: { session?: unknown },
    ) =>
      opts?.session
        ? Promise.reject(new Error('simulated organization failure'))
        : create(docs, opts)) as unknown as typeof organizationModel.create;
    let res: request.Response;
    try {
      res = await postRegister(app, body(email));
    } finally {
      organizationModel.create =
        create as unknown as typeof organizationModel.create;
    }
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.message).not.toBe(REGISTRATION_ACCEPTED_MESSAGE);
    expect(await userModel.countDocuments({ email })).toBe(0);
    expect(recorder.sentTo(email)).toHaveLength(0);
  });
});
