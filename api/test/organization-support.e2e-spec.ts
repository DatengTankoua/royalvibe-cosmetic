import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { Model, Types } from 'mongoose';
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
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { SUBSCRIPTION_CLOCK } from './../src/subscriptions/subscription-clock';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import {
  SupportRequest,
  type SupportRequestDocument,
} from './../src/support/schemas/support-request.schema';
import {
  SUPPORT_CLOCK,
  SUPPORT_RECIPIENT,
} from './../src/support/support-constants';
import { SUPPORT_RATE_LIMIT_CODE } from './../src/support/support-rate-limiting';
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
  EmailDeliveryError,
  type EmailSender,
  type OutgoingEmail,
} from '../src/email-verification/email-sender';
import {
  E2E_EMAIL_VERIFIED_AT,
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';

/**
 * E2E 1-16C.1 — Assistance depuis l'organisation (`/support/*`).
 * MongoDB éphémère ; transport e-mail SIMULÉ (aucun appel Resend : `fetch`
 * global remplacé par un mock qui échoue s'il est appelé) ; horloge de
 * l'assistance injectable.
 */

const TEST_JWT_SECRET = 'support-e2e-only-secret';
const E2E_CORS_ORIGIN = 'https://support-e2e.example.com';
const PASSWORD = 'support-16c1-pw-!1x';
const OWNER_EMAIL = 'owner-support-16c1@stockmaster.test';

/** Les e-mails de vérification vont au recorder (confirmation auto) ; ceux
 * du support passent par un script de résultats contrôlé par le test. */
const verificationSender = createE2eEmailSender();

class ScriptedSupportSender implements EmailSender {
  /** Chaque APPEL au transport pour le support (réussi ou non). */
  readonly calls: OutgoingEmail[] = [];
  /** Envois ACCEPTÉS par le transport simulé. */
  readonly accepted: OutgoingEmail[] = [];
  /** Échecs à produire, dans l'ordre (vide : succès). */
  failures: EmailDeliveryError[] = [];
  /** Retient l'envoi jusqu'à libération (double clic). */
  gate: Promise<void> | null = null;

  isConfigured(): boolean {
    return true;
  }

  async send(email: OutgoingEmail): Promise<void> {
    if (email.to !== SUPPORT_RECIPIENT) return verificationSender.send(email);
    this.calls.push(email);
    if (this.gate) await this.gate;
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.accepted.push(email);
  }

  reset(): void {
    this.calls.length = 0;
    this.accepted.length = 0;
    this.failures = [];
    this.gate = null;
  }
}

const supportSender = new ScriptedSupportSender();
let clockOffsetMs = 0;
const supportClock = () => new Date(Date.now() + clockOffsetMs);
// Horloge des abonnements : décalée uniquement pour expirer l'essai.
let subscriptionOffsetMs = 0;
const subscriptionClock = () => new Date(Date.now() + subscriptionOffsetMs);

describe('Assistance depuis l’organisation (e2e 1-16C.1)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let userModel: Model<UserDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let organizationModel: Model<OrganizationDocument>;
  let supportModel: Model<SupportRequestDocument>;
  let originalFetch: typeof fetch;
  let fetchMock: jest.Mock;

  let orgId = '';
  let ownerId = '';
  let ownerToken = '';
  let adminToken = '';
  let sellerToken = '';
  let grantedSellerToken = '';
  let grantedSellerMembershipId = '';

  const http = () => request(app.getHttpServer());
  const context = (token: string) =>
    http().get('/support/context').set('Authorization', `Bearer ${token}`);
  const submit = (token: string, body: Record<string, unknown>) =>
    http()
      .post('/support/requests')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  // La limitation (garde) s'exécute AVANT la validation (pipe) : une requête
  // invalide consomme aussi le quota. Remise à zéro entre cas de validation.
  const resetQuota = () =>
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
  const login = (email: string, organizationId?: string) =>
    http()
      .post('/auth/login')
      .send({ email, password: PASSWORD, organizationId });

  const validBody = (overrides: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    category: 'technical',
    subject: 'Impossible de valider une vente',
    message: 'Bonjour,\nle bouton reste grisé depuis ce matin.',
    page: '/app/sales',
    ...overrides,
  });

  async function seedMember(
    label: string,
    role: 'admin' | 'seller',
    permissions: string[] = [],
  ): Promise<{ token: string; membershipId: string }> {
    const email = `${label}-support-16c1@stockmaster.test`;
    const user = await userModel.create({
      emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
      name: `${label} Support`,
      email,
      password: await bcrypt.hash(PASSWORD, 10),
    });
    const membership = await membershipModel.create({
      organizationId: new Types.ObjectId(orgId),
      userId: user._id,
      role,
      permissions,
      status: 'active',
    });
    const res = await login(email, orgId);
    expect(res.status).toBe(201);
    return {
      token: res.body.access_token as string,
      membershipId: membership._id.toString(),
    };
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
      process.env.PUBLIC_APP_URL = 'https://app.support-e2e.test';

      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(supportSender)
        .overrideProvider(SUPPORT_CLOCK)
        .useValue(supportClock)
        .overrideProvider(SUBSCRIPTION_CLOCK)
        .useValue(subscriptionClock)
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
      autoConfirmVerificationEmails(app, verificationSender);

      userModel = moduleFixture.get(getModelToken('User'));
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );
      supportModel = moduleFixture.get(getModelToken(SupportRequest.name));
      organizationModel = moduleFixture.get(getModelToken(Organization.name));

      const reg = await http().post('/auth/register').send({
        name: 'Awa Support',
        email: OWNER_EMAIL,
        password: PASSWORD,
        organizationName: 'Boutique Support',
      });
      expect(reg.status).toBe(201);
      orgId = reg.body.organization._id as string;
      ownerId = reg.body.user._id as string;
      const ownerLogin = await login(OWNER_EMAIL);
      expect(ownerLogin.status).toBe(201);
      ownerToken = ownerLogin.body.access_token as string;

      adminToken = (await seedMember('admin', 'admin')).token;
      sellerToken = (await seedMember('seller', 'seller')).token;
      const granted = await seedMember('granted', 'seller', [
        'support.contact',
      ]);
      grantedSellerToken = granted.token;
      grantedSellerMembershipId = granted.membershipId;
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

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = jest.fn(() => {
      throw new Error('Aucun appel réseau attendu');
    });
    global.fetch = fetchMock;
    supportSender.reset();
    clockOffsetMs = 0;
    subscriptionOffsetMs = 0;
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ─── Accès ───────────────────────────────────────────────────────────────

  it('propriétaire et administrateur : contexte construit par le serveur', async () => {
    const res = await context(ownerToken);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.body as object).sort()).toEqual([
      'membership',
      'organization',
      'user',
    ]);
    expect(res.body.user).toEqual({
      id: ownerId,
      name: 'Awa Support',
      email: OWNER_EMAIL,
    });
    expect(res.body.organization.id).toBe(orgId);
    expect(res.body.organization.name).toBe('Boutique Support');
    expect(res.body.membership.role).toBe('owner');
    expect(res.body.membership.permissions).toContain('support.contact');
    expect((await context(adminToken)).status).toBe(200);
  });

  it('vendeur sans droit : 403 sur le contexte et sur l’envoi, aucun e-mail ni registre', async () => {
    expect((await context(sellerToken)).status).toBe(403);
    const body = validBody();
    const res = await submit(sellerToken, body);
    expect(res.status).toBe(403);
    expect(supportSender.calls).toHaveLength(0);
    expect(await supportModel.countDocuments({ _id: body.requestId })).toBe(0);
  });

  it('vendeur avec le droit accordé : envoi accepté', async () => {
    expect((await context(grantedSellerToken)).status).toBe(200);
    const res = await submit(grantedSellerToken, validBody());
    expect(res.status).toBe(201);
    expect(supportSender.accepted).toHaveLength(1);
  });

  it('droit retiré après ouverture de la page : la requête suivante est refusée (relu en base)', async () => {
    const seller = await seedMember('revoked', 'seller', ['support.contact']);
    expect((await context(seller.token)).status).toBe(200);
    await membershipModel.updateOne(
      { _id: new Types.ObjectId(seller.membershipId) },
      { $set: { permissions: [] } },
    );
    expect((await submit(seller.token, validBody())).status).toBe(403);
    // Appartenance suspendue : refus même avec le droit rétabli.
    await membershipModel.updateOne(
      { _id: new Types.ObjectId(seller.membershipId) },
      { $set: { permissions: ['support.contact'], status: 'suspended' } },
    );
    expect((await submit(seller.token, validBody())).status).toBe(403);
    expect(supportSender.calls).toHaveLength(0);
  });

  /** Nouveau commerce isolé (propriétaire inscrit par la route publique). */
  async function registerIsolatedOwner(label: string) {
    const email = `${label}-owner-16c1@stockmaster.test`;
    const reg = await http()
      .post('/auth/register')
      .send({
        name: `${label} Owner`,
        email,
        password: PASSWORD,
        organizationName: `Boutique ${label}`.slice(0, 20),
      });
    expect(reg.status).toBe(201);
    const res = await login(email);
    expect(res.status).toBe(201);
    return {
      email,
      orgId: reg.body.organization._id as string,
      token: res.body.access_token as string,
    };
  }

  /** Refus attendu : aucun registre créé, aucun appel au transport. */
  async function expectRefusedWithoutEffect(
    token: string,
    status: number,
    code: string | undefined,
  ) {
    const body = validBody();
    const ctx = await context(token);
    const sent = await submit(token, body);
    for (const res of [ctx, sent]) {
      expect([res.status, res.body.code]).toEqual([status, code]);
    }
    expect(await supportModel.countDocuments({ _id: body.requestId })).toBe(0);
    expect(supportSender.calls).toHaveLength(0);
    return { ctx, sent };
  }

  it('abonnement expiré : jeton applicatif déjà ouvert refusé (SUBSCRIPTION_INACTIVE), sans registre ni envoi', async () => {
    const owner = await registerIsolatedOwner('expired');
    expect((await context(owner.token)).status).toBe(200);
    subscriptionOffsetMs = 30 * 24 * 60 * 60 * 1000; // après l'essai de 7 jours
    await expectRefusedWithoutEffect(owner.token, 403, 'SUBSCRIPTION_INACTIVE');
  });

  it('session limitée (jeton `subscription_limited`) : jamais d’accès à l’assistance, sans registre ni envoi', async () => {
    const owner = await registerIsolatedOwner('limited');
    subscriptionOffsetMs = 30 * 24 * 60 * 60 * 1000;
    const res = await login(owner.email);
    expect([res.status, res.body.code]).toEqual([403, 'SUBSCRIPTION_INACTIVE']);
    const restricted = res.body.restrictedToken as string;
    expect(typeof restricted).toBe('string');
    const ctx = await context(restricted);
    const body = validBody();
    const sent = await submit(restricted, body);
    // Refus selon les règles existantes des routes métier (même code que
    // pour toute route sans exception commerciale).
    expect(ctx.status).toBe(403);
    expect(sent.status).toBe(403);
    expect(ctx.body.code).toBe('SUBSCRIPTION_ACCESS_LIMITED');
    expect(sent.body.code).toBe('SUBSCRIPTION_ACCESS_LIMITED');
    expect(await supportModel.countDocuments({ _id: body.requestId })).toBe(0);
    expect(supportSender.calls).toHaveLength(0);
  });

  it('organisation suspendue : refus uniforme (ORGANIZATION_ACCESS_DENIED), sans registre ni envoi', async () => {
    const owner = await registerIsolatedOwner('suspended');
    expect((await context(owner.token)).status).toBe(200);
    await organizationModel.updateOne(
      { _id: new Types.ObjectId(owner.orgId) },
      { $set: { status: 'suspended' } },
    );
    await expectRefusedWithoutEffect(
      owner.token,
      403,
      'ORGANIZATION_ACCESS_DENIED',
    );
  });

  it('usurpation : champs d’identité ou de destinataire refusés (400), identifiant d’un autre membre refusé (409)', async () => {
    for (const extra of [
      { userId: new Types.ObjectId().toString() },
      { organizationId: new Types.ObjectId().toString() },
      { email: 'pirate@example.com' },
      { to: 'pirate@example.com' },
      { replyTo: 'pirate@example.com' },
      { role: 'owner' },
    ]) {
      resetQuota();
      const res = await submit(grantedSellerToken, validBody(extra));
      expect(res.status).toBe(400);
    }
    expect(supportSender.calls).toHaveLength(0);

    resetQuota();
    const body = validBody();
    expect((await submit(ownerToken, body)).status).toBe(201);
    const stolen = await submit(adminToken, body);
    expect(stolen.status).toBe(409);
    expect(stolen.body.code).toBe('SUPPORT_REQUEST_CONFLICT');
    expect(supportSender.calls).toHaveLength(1);
  });

  // ─── Contenu ─────────────────────────────────────────────────────────────

  it('message exact : destinataire fixe, Reply-To du compte, contexte serveur, HTML échappé', async () => {
    const body = validBody({
      category: 'subscription',
      subject: 'Facture <b>"urgent"</b> & cie',
      message: 'Ligne 1\n<script>alert("x")</script>\nLigne 3',
      appVersion: '1.2.3',
    });
    const res = await submit(grantedSellerToken, body);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('sent');
    expect(res.body.replayed).toBe(false);
    expect(res.body.reference).toMatch(/^AS-[0-9A-F]{8}$/);

    expect(supportSender.accepted).toHaveLength(1);
    const email = supportSender.accepted[0];
    expect(email.to).toBe(SUPPORT_RECIPIENT);
    expect(email.replyTo).toBe('granted-support-16c1@stockmaster.test');
    expect(email.idempotencyKey).toBe(`support-request/${body.requestId}`);
    expect(email.subject).toBe(
      `[Assistance Stock Master] Abonnement : Facture <b>"urgent"</b> & cie (${res.body.reference})`,
    );
    expect(email.subject).not.toMatch(/[\r\n]/);

    expect(email.text).toContain(
      'Ligne 1\n<script>alert("x")</script>\nLigne 3',
    );
    expect(email.text).toContain(
      'Demandeur : granted Support <granted-support-16c1@stockmaster.test>',
    );
    expect(email.text).toContain('Commerce : Boutique Support');
    expect(email.text).toContain('Rôle : Vendeur');
    expect(email.text).toContain(`Identifiant organisation : ${orgId}`);
    expect(email.text).toContain(
      `Identifiant d’appartenance : ${grantedSellerMembershipId}`,
    );
    expect(email.text).toContain('Page concernée : /app/sales');
    expect(email.text).toContain('Version de l’application : 1.2.3');
    expect(email.text).toContain(
      `Identifiant de la demande : ${body.requestId}`,
    );

    expect(email.html).not.toContain('<script>');
    expect(email.html).not.toContain('<b>');
    expect(email.html).toContain(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(email.html).toContain(
      'Facture &lt;b&gt;&quot;urgent&quot;&lt;/b&gt; &amp; cie',
    );

    // Aucun secret ni donnée métier joints.
    for (const forbidden of [
      'password',
      'mot de passe :',
      'token',
      'Bearer',
      'buyer',
    ]) {
      expect(email.text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }

    // Registre : ni sujet ni message conservés.
    const stored = await supportModel.findById(body.requestId).lean();
    expect(stored?.status).toBe('sent');
    const raw = JSON.stringify(stored);
    expect(raw).not.toContain('Facture');
    expect(raw).not.toContain('Ligne 1');
  });

  // ─── Rejeu et doublons ───────────────────────────────────────────────────

  it('rejeu identique : même référence, aucun second envoi ; contenu différent : 409', async () => {
    const body = validBody();
    const first = await submit(ownerToken, body);
    const second = await submit(ownerToken, body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.replayed).toBe(true);
    expect(second.body.reference).toBe(first.body.reference);
    expect(second.body.createdAt).toBe(first.body.createdAt);
    expect(supportSender.calls).toHaveLength(1);

    const changed = await submit(ownerToken, {
      ...body,
      message: 'Autre texte',
    });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('SUPPORT_REQUEST_MISMATCH');
    expect(supportSender.calls).toHaveLength(1);
  });

  it('double clic : un seul envoi, la requête concurrente est refusée (409 en cours)', async () => {
    let release!: () => void;
    supportSender.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const body = validBody();
    const firstPending = submit(ownerToken, body).then((r) => r);
    // Laisse la première requête prendre le verrou et atteindre le transport.
    while (supportSender.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const second = await submit(ownerToken, body);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('SUPPORT_REQUEST_IN_PROGRESS');
    release();
    const first = await firstPending;
    expect(first.status).toBe(201);
    expect(supportSender.calls).toHaveLength(1);
    expect(supportSender.accepted).toHaveLength(1);
  });

  // ─── Erreurs du transport ────────────────────────────────────────────────

  it('refus certain du transport : 503 générique, puis nouvel essai accepté', async () => {
    supportSender.failures = [new EmailDeliveryError('rejected', 422)];
    const body = validBody();
    const failed = await submit(ownerToken, body);
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('SUPPORT_DELIVERY_UNAVAILABLE');
    expect(JSON.stringify(failed.body)).not.toContain('422');
    expect((await supportModel.findById(body.requestId).lean())?.status).toBe(
      'failed',
    );
    const retry = await submit(ownerToken, body);
    expect(retry.status).toBe(201);
    expect(supportSender.accepted).toHaveLength(1);
  });

  it('résultat inconnu : renvoi avec la MÊME clé et le MÊME contenu dans la fenêtre', async () => {
    supportSender.failures = [new EmailDeliveryError('timeout')];
    const body = validBody();
    const uncertain = await submit(ownerToken, body);
    expect(uncertain.status).toBe(503);
    expect(uncertain.body.code).toBe('SUPPORT_DELIVERY_UNCERTAIN');
    expect(uncertain.body.reference).toMatch(/^AS-/);

    clockOffsetMs = 2 * 60 * 60 * 1000; // 2 h plus tard : dans la fenêtre
    const retry = await submit(ownerToken, body);
    expect(retry.status).toBe(201);
    expect(supportSender.calls).toHaveLength(2);
    const [a, b] = supportSender.calls;
    expect(b.idempotencyKey).toBe(a.idempotencyKey);
    expect(b.subject).toBe(a.subject);
    expect(b.text).toBe(a.text);
    expect(b.html).toBe(a.html);
    expect(b.replyTo).toBe(a.replyTo);
  });

  it('résultat inconnu au-delà de 23 h : aucun renvoi automatique (409 explicite)', async () => {
    supportSender.failures = [new EmailDeliveryError('network')];
    const body = validBody();
    expect((await submit(ownerToken, body)).status).toBe(503);
    clockOffsetMs = 23 * 60 * 60 * 1000 + 60_000;
    const late = await submit(ownerToken, body);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('SUPPORT_RETRY_WINDOW_EXPIRED');
    expect(late.body.reference).toMatch(/^AS-/);
    expect(supportSender.calls).toHaveLength(1);
  });

  it('erreur 5xx ou 409 du prestataire : traitée comme incertaine', async () => {
    supportSender.failures = [new EmailDeliveryError('rejected', 502)];
    const r1 = await submit(ownerToken, validBody());
    expect(r1.body.code).toBe('SUPPORT_DELIVERY_UNCERTAIN');
    supportSender.failures = [new EmailDeliveryError('rejected', 409)];
    const r2 = await submit(ownerToken, validBody());
    expect(r2.body.code).toBe('SUPPORT_DELIVERY_UNCERTAIN');
  });

  // ─── Validation et limitation ────────────────────────────────────────────

  it('bornes et injections : sujet, message, catégorie, page et contenu vide refusés', async () => {
    const cases: Array<[Record<string, unknown>, number]> = [
      [{ subject: 'x'.repeat(151) }, 400],
      [{ message: 'x'.repeat(5001) }, 400],
      [{ subject: 'Sujet\r\nBcc: pirate@example.com' }, 400],
      [{ subject: 'Sujet\nX' }, 400],
      [{ message: 'contrôle \u0007' }, 400],
      [{ category: 'billing' }, 400],
      [{ page: '/app/sales?token=secret' }, 400],
      [{ page: '/app/sales#frag' }, 400],
      [{ page: 'https://evil.example/app' }, 400],
      [{ appVersion: '1.0 <script>' }, 400],
      [{ requestId: 'pas-un-uuid' }, 400],
      [{ subject: '   ' }, 400],
      [{ message: '\n\n' }, 400],
    ];
    for (const [override, status] of cases) {
      resetQuota();
      const res = await submit(ownerToken, validBody(override));
      expect({ override, status: res.status }).toEqual({ override, status });
    }
    // Bornes exactes acceptées.
    resetQuota();
    const max = await submit(
      ownerToken,
      validBody({ subject: 's'.repeat(150), message: 'm'.repeat(5000) }),
    );
    expect(max.status).toBe(201);
    expect(supportSender.accepted).toHaveLength(1);
  });

  it('requêtes invalides comptées dans le quota (garde avant validation)', async () => {
    for (let i = 0; i < 5; i++) {
      expect(
        (await submit(ownerToken, validBody({ category: 'x' }))).status,
      ).toBe(400);
    }
    expect((await submit(ownerToken, validBody())).status).toBe(429);
    expect(supportSender.calls).toHaveLength(0);
  });

  it('limitation dédiée : 5 demandes puis 429 par utilisateur et organisation, sans effet sur un autre membre', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await submit(ownerToken, validBody())).status).toBe(201);
    }
    const blocked = await submit(ownerToken, validBody());
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe(SUPPORT_RATE_LIMIT_CODE);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(supportSender.calls).toHaveLength(5);
    // Autre utilisateur, même organisation : quota distinct.
    expect((await submit(adminToken, validBody())).status).toBe(201);
    // Les routes de connexion n'évaluent pas cette fenêtre.
    expect((await login(OWNER_EMAIL)).status).toBe(201);
  });
});
