import 'reflect-metadata';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Model, Types, createConnection } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument } from './../src/users/schemas/user.schema';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import { OrganizationInvitation } from './../src/organizations/schemas/invitation.schema';
import type { OrganizationInvitationDocument } from './../src/organizations/schemas/invitation.schema';
import { SUBSCRIPTION_CLOCK } from './../src/subscriptions/subscription-clock';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import {
  LEGAL_ARCHIVE,
  LEGAL_CLOCK,
  legalAcceptanceKey,
} from '../src/legal/legal-acceptance.service';
import {
  LEGAL_ARCHIVE_DIR,
  LegalAcceptanceContext,
  LegalArchive,
  PRIVACY_NOTICE,
  type ResolvedLegalDocument,
  SUBSCRIPTION_TERMS,
  TERMS_OF_USE,
  sha256Hex,
} from '../src/legal/legal-documents';
import {
  LEGAL_ACCEPTANCES_COLLECTION,
  LEGAL_DOCUMENT_VERSIONS_COLLECTION,
  LegalAcceptance,
  type LegalAcceptanceDocument,
  LegalDocumentVersion,
  type LegalDocumentVersionDocument,
} from '../src/legal/schemas/legal-acceptance.schema';
import {
  LEGAL_ACCEPTANCE_USER_INDEX_NAME,
  ensureLegalAcceptanceIndexes,
} from '../src/legal/legal-acceptance-indexes';
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
  E2E_EMAIL_VERIFIED_AT,
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';
import {
  INVITATION_TERMS,
  OWNER_TERMS,
  legalAcceptanceFor,
  simulatedTurnstileToken,
} from './e2e/legal-acceptance-fixtures';
import {
  acceptWithSession,
  requestAccountToken,
} from './e2e/invitation-acceptance-fixtures';
import { postRegister } from './e2e/registration-fixtures';
import { REGISTRATION_ACCEPTED_MESSAGE } from '../src/auth/auth.service';

/**
 * E2E 1-16C.2 — Acceptation versionnée des conditions.
 * MongoDB ÉPHÉMÈRE uniquement ; transport e-mail simulé ; horloge et archive
 * juridiques injectables (archives de test dans un dossier temporaire, jamais
 * dans le dépôt).
 */

const TEST_JWT_SECRET = 'legal-e2e-only-secret';
const E2E_CORS_ORIGIN = 'https://legal-e2e.example.com';
const PASSWORD = 'legal-16c2-pw-!1x';
const sender = createE2eEmailSender();

/** Archive commutable : celle du dépôt, ou une archive de test temporaire. */
class SwitchableArchive extends LegalArchive {
  target: LegalArchive = new LegalArchive();
  getManifest() {
    return this.target.getManifest();
  }
  current(id: string, locale: string) {
    return this.target.current(id, locale);
  }
  currentVersion(id: string) {
    return this.target.currentVersion(id);
  }
  text(doc: ResolvedLegalDocument) {
    return this.target.text(doc);
  }
}

/** Copie temporaire de l'archive, modifiée par `mutate` (manifeste + texte). */
function archiveVariant(mutate: (dir: string, manifest: any) => void): {
  dir: string;
  archive: LegalArchive;
} {
  const dir = mkdtempSync(join(tmpdir(), 'legal-e2e-16c2-'));
  cpSync(LEGAL_ARCHIVE_DIR, dir, { recursive: true });
  const path = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  mutate(dir, manifest);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, archive: new LegalArchive(dir) };
}

const realArchive = new LegalArchive();
const current = (id: string) => realArchive.current(id, 'fr')!;

describe('Acceptation versionnée des conditions (e2e 1-16C.2)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let userModel: Model<UserDocument>;
  let organizationModel: Model<OrganizationDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let invitationModel: Model<OrganizationInvitationDocument>;
  let acceptanceModel: Model<LegalAcceptanceDocument>;
  let versionModel: Model<LegalDocumentVersionDocument>;
  const archive = new SwitchableArchive();
  const tempDirs: string[] = [];

  let legalNow = new Date('2031-05-06T07:08:09.000Z');
  let subscriptionOffsetMs = 0;

  let ownerEmail = '';
  let ownerId = '';
  let orgId = '';
  let ownerToken = '';

  const http = () => request(app.getHttpServer());
  const resetQuota = () =>
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
  const login = (email: string, organizationId?: string) =>
    http()
      .post('/auth/login')
      .send({ email, password: PASSWORD, organizationId });
  const status = (token: string) =>
    http().get('/legal/acceptance').set('Authorization', `Bearer ${token}`);
  const confirm = (token: string, body: unknown) =>
    http()
      .post('/legal/acceptance')
      .set('Authorization', `Bearer ${token}`)
      .send(body as object);
  const counts = async () => ({
    users: await userModel.countDocuments(),
    organizations: await organizationModel.countDocuments(),
    memberships: await membershipModel.countDocuments(),
    acceptances: await acceptanceModel.countDocuments(),
    versions: await versionModel.countDocuments(),
  });
  let seq = 0;
  const email = (label: string) =>
    `${label}-${++seq}-16c2@stockmaster.test`.toLowerCase();
  // 1-18C : jeton anti-robot simulé toujours présent (les refus testés ici
  // sont ceux des conditions, après la vérification anti-robot).
  const registerBody = (address: string, extra: object = OWNER_TERMS) => ({
    name: 'Owner Legal',
    email: address,
    password: PASSWORD,
    organizationName: 'Boutique Legal',
    turnstileToken: simulatedTurnstileToken(),
    ...extra,
  });

  async function seedMember(
    label: string,
    role: 'admin' | 'seller',
    organizationId: string,
  ): Promise<{ userId: string; email: string; membershipId: string }> {
    const address = email(label);
    const user = await userModel.create({
      emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
      name: `${label} Legal`.slice(0, 20),
      email: address,
      password: await bcrypt.hash(PASSWORD, 10),
    });
    const membership = await membershipModel.create({
      organizationId: new Types.ObjectId(organizationId),
      userId: user._id,
      role,
      permissions: [],
      status: 'active',
    });
    return {
      userId: user._id.toString(),
      email: address,
      membershipId: membership._id.toString(),
    };
  }

  async function tokenFor(address: string, organizationId: string) {
    const res = await login(address, organizationId);
    expect(res.status).toBe(201);
    return res.body.access_token as string;
  }

  async function invite(address: string): Promise<string> {
    const issued = await http()
      .post('/organizations/invitations')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: address, role: 'seller' });
    expect(issued.status).toBe(201);
    return new URL(issued.body.invitationUrl as string).searchParams.get(
      'token',
    )!;
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
      process.env.PUBLIC_APP_URL = 'https://app.legal-e2e.test';
      delete process.env.LEGAL_ACCEPTANCE_PROMPT_ENABLED;

      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(sender)
        .overrideProvider(LEGAL_CLOCK)
        .useValue(() => legalNow)
        .overrideProvider(LEGAL_ARCHIVE)
        .useValue(archive)
        .overrideProvider(SUBSCRIPTION_CLOCK)
        .useValue(() => new Date(Date.now() + subscriptionOffsetMs))
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
      autoConfirmVerificationEmails(app, sender);

      userModel = moduleFixture.get(getModelToken('User'));
      organizationModel = moduleFixture.get(getModelToken(Organization.name));
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );
      invitationModel = moduleFixture.get(
        getModelToken(OrganizationInvitation.name),
      );
      acceptanceModel = moduleFixture.get(getModelToken(LegalAcceptance.name));
      versionModel = moduleFixture.get(
        getModelToken(LegalDocumentVersion.name),
      );
      // Collections et index créés comme en production (migration explicite).
      await ensureLegalAcceptanceIndexes(
        moduleFixture.get<Connection>(getConnectionToken()),
      );
    } catch (err) {
      if (moduleFixture) await moduleFixture.close().catch(() => undefined);
      await stopEphemeralMongoSafe();
      throw err;
    }
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    delete process.env.LEGAL_ACCEPTANCE_PROMPT_ENABLED;
  }, 60_000);

  beforeEach(async () => {
    archive.target = realArchive;
    subscriptionOffsetMs = 0;
    await resetQuota();
  });

  // ─── Inscription : refus ─────────────────────────────────────────────────

  it('inscription sans acceptation : 400 LEGAL_ACCEPTANCE_REQUIRED, ni compte ni commerce', async () => {
    const before = await counts();
    const res = await postRegister(app, registerBody(email('none'), {}));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LEGAL_ACCEPTANCE_REQUIRED');
    expect(await counts()).toEqual(before);
  });

  it('case non cochée, conditions d’abonnement absentes, version périmée, traduction inexistante : refus sans écriture', async () => {
    const before = await counts();
    const valid = legalAcceptanceFor(LegalAcceptanceContext.OWNER_REGISTRATION);
    const cases: Array<[object, number, string]> = [
      [{ ...valid, accepted: false }, 400, 'LEGAL_ACCEPTANCE_REQUIRED'],
      [
        { ...valid, documents: valid.documents.slice(0, 1) },
        400,
        'LEGAL_ACCEPTANCE_REQUIRED',
      ],
      [
        {
          ...valid,
          documents: [{ id: TERMS_OF_USE, version: '0.2' }, valid.documents[1]],
        },
        409,
        'LEGAL_VERSION_OUTDATED',
      ],
      // 1-16G : l'anglais existe ; une langue sans document est refusée.
      [{ ...valid, locale: 'de' }, 400, 'LEGAL_LOCALE_UNAVAILABLE'],
      [
        {
          ...valid,
          documents: [
            ...valid.documents,
            { id: 'mentions-legales', version: '0.2' },
          ],
        },
        400,
        'LEGAL_DOCUMENTS_INVALID',
      ],
    ];
    for (const [legalAcceptance, code, errorCode] of cases) {
      await resetQuota();
      const res = await postRegister(
        app,
        registerBody(email('refused'), { legalAcceptance }),
      );
      expect([res.status, res.body.code]).toEqual([code, errorCode]);
    }
    expect(await counts()).toEqual(before);
  });

  it('date, empreinte et identité impossibles à imposer : 400 (forbidNonWhitelisted)', async () => {
    const before = await counts();
    const valid = legalAcceptanceFor(LegalAcceptanceContext.OWNER_REGISTRATION);
    const forged: object[] = [
      { legalAcceptance: { ...valid, acceptedAt: '2020-01-01T00:00:00Z' } },
      {
        legalAcceptance: {
          ...valid,
          documents: valid.documents.map((d) => ({ ...d, sha256: 'x' })),
        },
      },
      { legalAcceptance: { ...valid, userId: new Types.ObjectId() } },
      { ...OWNER_TERMS, acceptedAt: '2020-01-01T00:00:00Z' },
    ];
    for (const extra of forged) {
      await resetQuota();
      const res = await postRegister(app, registerBody(email('forged'), extra));
      expect(res.status).toBe(400);
    }
    expect(await counts()).toEqual(before);
  });

  // ─── Inscription : preuve ────────────────────────────────────────────────

  it('succès : preuve enregistrée par le serveur (date serveur, versions et empreintes du manifeste, commerce créé)', async () => {
    ownerEmail = email('owner');
    const res = await postRegister(app, registerBody(ownerEmail));
    expect(res.status).toBe(202);
    ownerId = res.owner!.user._id;
    orgId = res.owner!.organization._id;
    ownerToken = await tokenFor(ownerEmail, orgId);

    const proofs = await acceptanceModel.find({ userId: ownerId }).lean();
    expect(proofs).toHaveLength(1);
    const proof = proofs[0];
    const cgu = current(TERMS_OF_USE);
    const cga = current(SUBSCRIPTION_TERMS);
    const privacy = current(PRIVACY_NOTICE);
    expect(proof._id).toBe(
      legalAcceptanceKey({
        userId: ownerId,
        organizationId: orgId,
        context: LegalAcceptanceContext.OWNER_REGISTRATION,
        documents: [cgu, cga],
      }),
    );
    expect(proof.organizationId!.toString()).toBe(orgId);
    expect(proof.context).toBe('owner_registration');
    // Date du SERVEUR (horloge injectée), aucune date venue du navigateur.
    expect(proof.acceptedAt.toISOString()).toBe(legalNow.toISOString());
    expect(proof.locale).toBe('fr');
    const asProof = (d: ResolvedLegalDocument) => ({
      documentId: d.documentId,
      version: d.version,
      locale: 'fr',
      sha256: d.sha256,
      archiveId: `${d.documentId}@${d.version}/fr`,
    });
    expect(proof.acceptedDocuments).toEqual([asProof(cgu), asProof(cga)]);
    // Confidentialité : PRÉSENTÉE pour information, jamais « acceptée ».
    expect(proof.presentedNotices).toEqual([asProof(privacy)]);

    // Textes archivés en base : identiques octet pour octet à l'archive.
    for (const d of [cgu, cga, privacy]) {
      const stored = await versionModel
        .findById(`${d.documentId}@${d.version}/fr`)
        .lean();
      expect(stored?.sha256).toBe(d.sha256);
      expect(stored?.text).toBe(
        readFileSync(join(LEGAL_ARCHIVE_DIR, d.file), 'utf8'),
      );
      expect(sha256Hex(stored!.text)).toBe(d.sha256);
      expect(stored?.archivedAt.toISOString()).toBe(legalNow.toISOString());
    }
  });

  it('rejeu de l’inscription (1-18E) : même 202 neutre, aucune seconde preuve', async () => {
    const before = await counts();
    const res = await postRegister(app, registerBody(ownerEmail));
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ message: REGISTRATION_ACCEPTED_MESSAGE });
    expect(await counts()).toEqual(before);
  });

  // ─── Inscription en anglais (1-16G) ─────────────────────────────────────

  it('1-16G — inscription en anglais : preuve des textes anglais, archives françaises intactes, préférence et e-mail en anglais', async () => {
    const frVersionsBefore = await versionModel
      .find({ _id: { $regex: '/fr$' } })
      .sort({ _id: 1 })
      .lean();
    expect(frVersionsBefore.length).toBeGreaterThanOrEqual(3);
    const address = email('owner-en');
    const valid = legalAcceptanceFor(LegalAcceptanceContext.OWNER_REGISTRATION);
    const res = await postRegister(
      app,
      registerBody(address, {
        legalAcceptance: { ...valid, locale: 'en' },
      }),
      { 'Accept-Language': 'en' },
    );
    expect(res.status).toBe(202);
    const userId = res.owner!.user._id;
    const organizationId = res.owner!.organization._id;

    const [proof] = await acceptanceModel.find({ userId }).lean();
    expect(proof.locale).toBe('en');
    const english = (id: string) => realArchive.current(id, 'en')!;
    const asProof = (d: ResolvedLegalDocument) => ({
      documentId: d.documentId,
      version: d.version,
      locale: 'en',
      sha256: d.sha256,
      archiveId: `${d.documentId}@${d.version}/en`,
    });
    expect(proof.acceptedDocuments).toEqual([
      asProof(english(TERMS_OF_USE)),
      asProof(english(SUBSCRIPTION_TERMS)),
    ]);
    expect(proof.presentedNotices).toEqual([asProof(english(PRIVACY_NOTICE))]);
    for (const id of [TERMS_OF_USE, SUBSCRIPTION_TERMS, PRIVACY_NOTICE]) {
      const d = english(id);
      // Même version que le texte français : seule la langue diffère.
      expect(d.version).toBe(current(id).version);
      const stored = await versionModel
        .findById(`${id}@${d.version}/en`)
        .lean();
      expect(stored?.text).toBe(
        readFileSync(join(LEGAL_ARCHIVE_DIR, d.file), 'utf8'),
      );
      expect(sha256Hex(stored!.text)).toBe(d.sha256);
    }
    // Textes français déjà archivés : ni modifiés ni remplacés.
    expect(
      await versionModel
        .find({ _id: { $regex: '/fr$' } })
        .sort({ _id: 1 })
        .lean(),
    ).toEqual(frVersionsBefore);

    // Préférence du compte : langue des envois (e-mail de confirmation).
    expect((await userModel.findById(userId).lean())!.locale).toBe('en');
    const [mail] = sender.sentTo(address);
    expect(mail.subject).toBe('Confirm your email address – Stock Master');

    const token = await tokenFor(address, organizationId);
    const me = await http()
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(me.body.locale).toBe('en');
  });

  it('1-16G — PUT /auth/me/locale : seule la préférence change, valeur contrôlée, compte authentifié', async () => {
    const before = (await userModel.findOne({ email: ownerEmail }).lean())!;
    // Inscrit avec les textes français : préférence initiale française.
    expect(before.locale).toBe('fr');
    const put = (body: object, token?: string) => {
      const req = http().put('/auth/me/locale');
      if (token) req.set('Authorization', `Bearer ${token}`);
      return req.send(body);
    };
    expect((await put({ locale: 'en' })).status).toBe(401);
    expect((await put({ locale: 'de' }, ownerToken)).status).toBe(400);
    expect(
      (await put({ locale: 'en', userId: new Types.ObjectId() }, ownerToken))
        .status,
    ).toBe(400);
    const ok = await put({ locale: 'en' }, ownerToken);
    expect([ok.status, ok.body]).toEqual([200, { locale: 'en' }]);
    expect(ok.headers['cache-control']).toBe('no-store');
    const after = (await userModel.findOne({ email: ownerEmail }).lean())!;
    expect(after.locale).toBe('en');
    expect({ ...after, locale: undefined, updatedAt: undefined }).toEqual({
      ...before,
      locale: undefined,
      updatedAt: undefined,
    });
    await put({ locale: 'fr' }, ownerToken);
    expect(
      (await userModel.findOne({ email: ownerEmail }).lean())!.locale,
    ).toBe('fr');
  });

  it('1-16G — erreurs : message dans la langue demandée, code et statut inchangés', async () => {
    const wrong = (language?: string) => {
      const req = http().post('/auth/login');
      if (language) req.set('Accept-Language', language);
      return req.send({ email: ownerEmail, password: 'wrong-password-1!' });
    };
    const [none, fr, en] = await Promise.all([
      wrong(),
      wrong('fr-FR,fr;q=0.9'),
      wrong('en-GB,en;q=0.9,fr;q=0.5'),
    ]);
    expect([none.status, fr.status, en.status]).toEqual([401, 401, 401]);
    expect(none.body.message).toBe('Email ou mot de passe incorrect!');
    expect(fr.body.message).toBe('Email ou mot de passe incorrect!');
    expect(en.body.message).toBe('Incorrect email or password.');
    const rest = (body: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(body).filter(
          ([key]) => key !== 'message' && key !== 'timestamp',
        ),
      );
    expect(rest(en.body as Record<string, unknown>)).toEqual(
      rest(none.body as Record<string, unknown>),
    );
    // Code stable jamais traduit.
    const locale = await http()
      .post('/auth/register')
      .set('Accept-Language', 'en')
      .send(
        registerBody(email('refused-en'), {
          legalAcceptance: {
            ...legalAcceptanceFor(LegalAcceptanceContext.OWNER_REGISTRATION),
            locale: 'de',
          },
        }),
      );
    expect([locale.status, locale.body.code]).toEqual([
      400,
      'LEGAL_LOCALE_UNAVAILABLE',
    ]);
  });

  // ─── Invitation ──────────────────────────────────────────────────────────

  it('invitation, nouveau compte : refus sans case (invitation intacte), puis preuve des seules conditions d’utilisation', async () => {
    const address = email('invitee');
    const invitationToken = await invite(address);
    // 1-18B : compte créé depuis le lien reçu à l'adresse invitée.
    const token = await requestAccountToken(
      app.getHttpServer(),
      sender,
      invitationToken,
      address,
    );
    const createAccount = (body: Record<string, unknown>) =>
      http()
        .post('/auth/invitations/create-account')
        .send({ token, name: 'Invité', password: PASSWORD, ...body });

    await resetQuota();
    const refused = await createAccount({});
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('LEGAL_ACCEPTANCE_REQUIRED');
    expect((await invitationModel.findOne({ email: address }))!.status).toBe(
      'pending',
    );
    expect(await userModel.countDocuments({ email: address })).toBe(0);

    // Les conditions d'abonnement ne concernent pas un membre invité.
    await resetQuota();
    const withSubscription = await createAccount({
      legalAcceptance: legalAcceptanceFor(
        LegalAcceptanceContext.OWNER_REGISTRATION,
      ),
    });
    expect(withSubscription.status).toBe(400);
    expect(withSubscription.body.code).toBe('LEGAL_DOCUMENTS_INVALID');

    await resetQuota();
    legalNow = new Date('2031-05-07T10:00:00.000Z');
    const accepted = await createAccount({ ...INVITATION_TERMS });
    expect(accepted.status).toBe(200);
    const userId = (await userModel.findOne({ email: address }))!._id;
    const proofs = await acceptanceModel.find({ userId }).lean();
    expect(proofs).toHaveLength(1);
    expect(proofs[0].context).toBe('invitation_account');
    expect(proofs[0].organizationId!.toString()).toBe(orgId);
    expect(proofs[0].acceptedAt.toISOString()).toBe(legalNow.toISOString());
    expect(proofs[0].acceptedDocuments.map((d) => d.documentId)).toEqual([
      TERMS_OF_USE,
    ]);
    expect(proofs[0].presentedNotices.map((d) => d.documentId)).toEqual([
      PRIVACY_NOTICE,
    ]);
  });

  it('invitation, compte existant : rattaché par sa session sans preuve ; une acceptation jointe est refusée (le lien ne prouve pas l’identité)', async () => {
    const other = await postRegister(app, {
      ...registerBody(email('existing')),
      organizationName: 'Autre commerce',
    });
    expect(other.status).toBe(202);
    const existingId = other.owner!.user._id;
    const existingEmail = other.owner!.user.email;
    const before = await acceptanceModel.countDocuments({
      userId: existingId,
    });
    const token = await invite(existingEmail);
    await resetQuota();
    const session = await tokenFor(
      existingEmail,
      other.owner!.organization._id,
    );
    const withTerms = await http()
      .post('/auth/invitations/accept')
      .set('Authorization', `Bearer ${session}`)
      .send({ ...INVITATION_TERMS, token, consent: true });
    expect(withTerms.status).toBe(400);
    expect(
      (await invitationModel.findOne({ email: existingEmail }))!.status,
    ).toBe('pending');
    const res = await acceptWithSession(app.getHttpServer(), session, token);
    expect(res.status).toBe(200);
    expect(await acceptanceModel.countDocuments({ userId: existingId })).toBe(
      before,
    );
    expect(
      await acceptanceModel.countDocuments({
        userId: existingId,
        organizationId: new Types.ObjectId(orgId),
      }),
    ).toBe(0);
  });

  // ─── Comptes existants ───────────────────────────────────────────────────

  it('compte existant sans preuve : statut, refus des soumissions incorrectes, confirmation, rejeu sans doublon', async () => {
    const seller = await seedMember('seller', 'seller', orgId);
    const token = await tokenFor(seller.email, orgId);

    // Aucune acceptation inventée pour un compte antérieur.
    expect(
      await acceptanceModel.countDocuments({ userId: seller.userId }),
    ).toBe(0);
    const first = await status(token);
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.body).toEqual({
      promptEnabled: false,
      locale: 'fr',
      pending: [{ id: TERMS_OF_USE, version: current(TERMS_OF_USE).version }],
      notices: [
        { id: PRIVACY_NOTICE, version: current(PRIVACY_NOTICE).version },
      ],
    });
    process.env.LEGAL_ACCEPTANCE_PROMPT_ENABLED = 'true';
    expect((await status(token)).body.promptEnabled).toBe(true);
    delete process.env.LEGAL_ACCEPTANCE_PROMPT_ENABLED;

    const pendingBody = (overrides: object = {}) => ({
      accepted: true,
      locale: 'fr',
      documents: first.body.pending,
      notices: first.body.notices,
      ...overrides,
    });
    // Un vendeur n'accepte pas les conditions d'abonnement.
    const withSubscription = await confirm(
      token,
      pendingBody({
        documents: [
          ...first.body.pending,
          {
            id: SUBSCRIPTION_TERMS,
            version: current(SUBSCRIPTION_TERMS).version,
          },
        ],
      }),
    );
    expect(withSubscription.status).toBe(400);
    expect(withSubscription.body.code).toBe('LEGAL_DOCUMENTS_INVALID');
    const unchecked = await confirm(token, pendingBody({ accepted: false }));
    expect(unchecked.body.code).toBe('LEGAL_ACCEPTANCE_REQUIRED');
    const outdated = await confirm(
      token,
      pendingBody({ documents: [{ id: TERMS_OF_USE, version: '0.2' }] }),
    );
    expect(outdated.status).toBe(409);
    expect(outdated.body.code).toBe('LEGAL_VERSION_OUTDATED');
    const forgedDate = await confirm(
      token,
      pendingBody({ acceptedAt: '2020-01-01T00:00:00Z' }),
    );
    expect(forgedDate.status).toBe(400);
    expect(
      await acceptanceModel.countDocuments({ userId: seller.userId }),
    ).toBe(0);

    legalNow = new Date('2031-06-01T08:00:00.000Z');
    const ok = await confirm(token, pendingBody());
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('recorded');
    const proof = await acceptanceModel
      .findOne({ userId: seller.userId })
      .lean();
    expect(proof!.context).toBe('account_confirmation');
    expect(proof!.acceptedAt.toISOString()).toBe(legalNow.toISOString());
    expect(proof!.organizationId!.toString()).toBe(orgId);

    expect((await status(token)).body).toMatchObject({
      pending: [],
      notices: [],
    });
    // Rejeu : aucune nouvelle preuve.
    const replay = await confirm(token, pendingBody());
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe('already-accepted');
    expect(
      await acceptanceModel.countDocuments({ userId: seller.userId }),
    ).toBe(1);
  });

  it('nouveau propriétaire après transfert : seules les conditions d’abonnement de CE commerce restent à accepter', async () => {
    const admin = await seedMember('admin', 'admin', orgId);
    const adminToken = await tokenFor(admin.email, orgId);
    expect((await status(adminToken)).body.pending).toEqual([
      { id: TERMS_OF_USE, version: current(TERMS_OF_USE).version },
    ]);
    // Une utilisation métier n'est pas conditionnée à l'acceptation.
    expect(
      (
        await http()
          .get('/products')
          .set('Authorization', `Bearer ${adminToken}`)
      ).status,
    ).toBe(200);
    // Propriétaire inscrit : rien en attente.
    expect((await status(ownerToken)).body.pending).toEqual([]);

    const transfer = await http()
      .post(`/organizations/members/${admin.membershipId}/transfer-ownership`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});
    expect(transfer.status).toBeLessThan(300);
    // Rôle relu en base à chaque requête : même jeton.
    const after = await status(adminToken);
    expect(after.body.pending).toEqual([
      { id: TERMS_OF_USE, version: current(TERMS_OF_USE).version },
      { id: SUBSCRIPTION_TERMS, version: current(SUBSCRIPTION_TERMS).version },
    ]);
    // L'ancien propriétaire a déjà accepté les conditions d'utilisation.
    const formerOwnerToken = await tokenFor(ownerEmail, orgId);
    expect((await status(formerOwnerToken)).body.pending).toEqual([]);
    ownerToken = await tokenFor(admin.email, orgId);

    const ok = await confirm(ownerToken, {
      accepted: true,
      locale: 'fr',
      documents: after.body.pending,
      notices: after.body.notices,
    });
    expect(ok.body.status).toBe('recorded');
    const proof = await acceptanceModel
      .findOne({ userId: admin.userId })
      .lean();
    expect(proof!.acceptedDocuments.map((d) => d.documentId)).toEqual([
      TERMS_OF_USE,
      SUBSCRIPTION_TERMS,
    ]);
  });

  // ─── Nouvelle version et archive ─────────────────────────────────────────

  it('conditions d’abonnement 0.3 → 0.4 : ancienne version refusée, preuve 0.3 conservée, nouvelle confirmation demandée', async () => {
    const cga = current(SUBSCRIPTION_TERMS);
    expect(cga.version).toBe('0.4');
    const valid = legalAcceptanceFor(LegalAcceptanceContext.OWNER_REGISTRATION);
    const withOld = {
      ...valid,
      documents: valid.documents.map((d) =>
        d.id === SUBSCRIPTION_TERMS ? { ...d, version: '0.3' } : d,
      ),
    };
    // Soumission portant l'ancienne version : refusée, rien n'est écrit.
    const before = await counts();
    const stale = await postRegister(
      app,
      registerBody(email('cga03'), { legalAcceptance: withOld }),
    );
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('LEGAL_VERSION_OUTDATED');
    expect(stale.body.current).toContainEqual({
      id: SUBSCRIPTION_TERMS,
      version: '0.4',
    });
    expect(await counts()).toEqual(before);

    // Propriétaire inscrit quand la 0.3 était en vigueur (archive d'époque).
    const was03 = archiveVariant((_dir, manifest) => {
      manifest.documents[SUBSCRIPTION_TERMS].current = '0.3';
    });
    tempDirs.push(was03.dir);
    archive.target = was03.archive;
    const address = email('owner03');
    legalNow = new Date('2031-04-01T09:00:00.000Z');
    const reg = await postRegister(
      app,
      registerBody(address, { legalAcceptance: withOld }),
    );
    expect(reg.status).toBe(202);
    const userId = reg.owner!.user._id;
    const organizationId = reg.owner!.organization._id;
    const proof03 = await acceptanceModel.findOne({ userId }).lean();
    expect(
      proof03!.acceptedDocuments.find(
        (d) => d.documentId === SUBSCRIPTION_TERMS,
      ),
    ).toMatchObject({
      version: '0.3',
      sha256:
        '7efc7db353af8c9b842e798fb810c8b0082f16d9fe2c0bf116e7218c45a50e72',
    });
    const text03 = await versionModel
      .findById(`${SUBSCRIPTION_TERMS}@0.3/fr`)
      .lean();

    // Retour à l'archive du dépôt : la 0.4 est en vigueur.
    archive.target = realArchive;
    const token = await tokenFor(address, organizationId);
    const s = await status(token);
    expect(s.body.pending).toEqual([
      { id: SUBSCRIPTION_TERMS, version: '0.4' },
    ]);
    legalNow = new Date('2031-04-02T09:00:00.000Z');
    const ok = await confirm(token, {
      accepted: true,
      locale: 'fr',
      documents: s.body.pending,
      notices: s.body.notices,
    });
    expect(ok.body.status).toBe('recorded');

    // Preuve 0.3 et texte 0.3 inchangés ; 0.4 archivée avec texte et empreinte exacts.
    expect(await acceptanceModel.findById(proof03!._id).lean()).toEqual(
      proof03,
    );
    expect(
      await versionModel.findById(`${SUBSCRIPTION_TERMS}@0.3/fr`).lean(),
    ).toEqual(text03);
    const text04 = await versionModel
      .findById(`${SUBSCRIPTION_TERMS}@0.4/fr`)
      .lean();
    expect(text04!.sha256).toBe(cga.sha256);
    expect(text04!.text).toBe(
      readFileSync(join(LEGAL_ARCHIVE_DIR, cga.file), 'utf8'),
    );
    expect(text04!.text).toContain(
      "Le paiement en ligne n'est pas encore activé.",
    );
    const proofs = await acceptanceModel.find({ userId }).lean();
    expect(proofs).toHaveLength(2);
    expect((await status(token)).body.pending).toEqual([]);
  });

  it('nouvelle version : ni les textes ni les preuves précédents ne sont modifiés', async () => {
    const cgu = current(TERMS_OF_USE);
    const proofsBefore = await acceptanceModel.find().sort({ _id: 1 }).lean();
    const versionBefore = await versionModel
      .findById(`${TERMS_OF_USE}@${cgu.version}/fr`)
      .lean();
    expect(versionBefore).not.toBeNull();

    const v2 = archiveVariant((dir, manifest) => {
      const text = `${readFileSync(join(dir, cgu.file), 'utf8')}Ajout de la version 9.0.\n`;
      writeFileSync(join(dir, TERMS_OF_USE, '9.0.fr.txt'), text);
      manifest.documents[TERMS_OF_USE].versions['9.0'] = {
        publishedAt: '2031-07-01',
        locales: {
          fr: { file: `${TERMS_OF_USE}/9.0.fr.txt`, sha256: sha256Hex(text) },
        },
      };
      manifest.documents[TERMS_OF_USE].current = '9.0';
    });
    tempDirs.push(v2.dir);
    archive.target = v2.archive;

    const token = await tokenFor(ownerEmail, orgId);
    const s = await status(token);
    expect(s.body.pending).toEqual([{ id: TERMS_OF_USE, version: '9.0' }]);
    const stale = await confirm(token, {
      accepted: true,
      locale: 'fr',
      documents: [{ id: TERMS_OF_USE, version: cgu.version }],
      notices: s.body.notices,
    });
    expect(stale.status).toBe(409);
    legalNow = new Date('2031-07-02T09:00:00.000Z');
    const ok = await confirm(token, {
      accepted: true,
      locale: 'fr',
      documents: s.body.pending,
      notices: s.body.notices,
    });
    expect(ok.body.status).toBe('recorded');

    // Anciennes preuves strictement inchangées ; nouvelle preuve ajoutée.
    const proofsAfter = await acceptanceModel.find().sort({ _id: 1 }).lean();
    for (const before of proofsBefore) {
      expect(proofsAfter).toContainEqual(before);
    }
    expect(proofsAfter).toHaveLength(proofsBefore.length + 1);
    expect(
      await versionModel.findById(`${TERMS_OF_USE}@${cgu.version}/fr`).lean(),
    ).toEqual(versionBefore);
    const v9 = await versionModel.findById(`${TERMS_OF_USE}@9.0/fr`).lean();
    expect(v9?.text).toContain('Ajout de la version 9.0.');
  });

  it('version déjà archivée en base avec un autre texte : 503, aucune écriture (jamais de réécriture)', async () => {
    const cga = current(SUBSCRIPTION_TERMS);
    const stored = await versionModel
      .findById(`${SUBSCRIPTION_TERMS}@${cga.version}/fr`)
      .lean();
    const altered = archiveVariant((dir, manifest) => {
      const text = 'Texte différent pour la même version.\n';
      writeFileSync(join(dir, cga.file), text);
      manifest.documents[SUBSCRIPTION_TERMS].versions[
        cga.version
      ].locales.fr.sha256 = sha256Hex(text);
    });
    tempDirs.push(altered.dir);
    archive.target = altered.archive;

    const before = await counts();
    const res = await postRegister(app, registerBody(email('conflict')));
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('LEGAL_ARCHIVE_UNAVAILABLE');
    expect(await counts()).toEqual(before);
    expect(
      await versionModel
        .findById(`${SUBSCRIPTION_TERMS}@${cga.version}/fr`)
        .lean(),
    ).toEqual(stored);
  });

  it('immuabilité côté application : aucune modification ni suppression par les modèles', async () => {
    const proof = await acceptanceModel.findOne({ userId: ownerId });
    expect(proof).not.toBeNull();
    const snapshot = proof!.toObject();
    await expect(
      acceptanceModel.updateOne(
        { _id: proof!._id },
        { $set: { acceptedAt: new Date('2000-01-01') } },
      ),
    ).rejects.toThrow(/immuable/);
    await expect(
      acceptanceModel.findOneAndUpdate({ _id: proof!._id }, { locale: 'en' }),
    ).rejects.toThrow(/immuable/);
    await expect(
      acceptanceModel.deleteOne({ _id: proof!._id }),
    ).rejects.toThrow(/immuable/);
    await expect(proof!.deleteOne()).rejects.toThrow(/immuable/);
    proof!.locale = 'en';
    await expect(proof!.save()).rejects.toThrow(/immuable/);
    await expect(
      versionModel.updateMany({}, { $set: { text: 'réécrit' } }),
    ).rejects.toThrow(/immuable/);
    await expect(versionModel.deleteMany({})).rejects.toThrow(/immuable/);
    expect(
      (await acceptanceModel.findById(proof!._id).lean())!.acceptedAt,
    ).toEqual(snapshot.acceptedAt);
    expect(await versionModel.countDocuments()).toBeGreaterThanOrEqual(4);
  });

  // ─── Restrictions commerciales ───────────────────────────────────────────

  it('session limitée (abonnement expiré) : statut inaccessible, aucune acceptation ne lève la restriction', async () => {
    const fresh = await postRegister(app, registerBody(email('expired')));
    expect(fresh.status).toBe(202);
    subscriptionOffsetMs = 8 * 24 * 60 * 60 * 1000;
    const res = await login(fresh.owner!.user.email);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUBSCRIPTION_INACTIVE');
    const restricted = res.body.restrictedToken as string;
    expect(restricted).toEqual(expect.any(String));
    expect((await status(restricted)).status).toBe(403);
    const attempt = await confirm(restricted, {
      ...legalAcceptanceFor(LegalAcceptanceContext.OWNER_REGISTRATION),
    });
    expect(attempt.status).toBe(403);
    // Toujours limitée après la tentative.
    expect((await login(fresh.owner!.user.email)).status).toBe(403);
  });
});

describe('Migration legal_acceptances (e2e 1-16C.2)', () => {
  let connection: Connection;

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    connection = await createConnection(
      validatedEphemeralUri(replSet),
    ).asPromise();
  }, 180_000);

  afterAll(async () => {
    if (connection) await connection.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  const indexes = async () =>
    (await connection
      .db!.collection(LEGAL_ACCEPTANCES_COLLECTION)
      .listIndexes()
      .toArray()) as Array<{
      name?: string;
      key: Record<string, unknown>;
      expireAfterSeconds?: number;
    }>;

  it('crée les deux collections et l’index de lecture, sans TTL', async () => {
    await expect(ensureLegalAcceptanceIndexes(connection)).resolves.toBe(
      'created',
    );
    const names = (await connection.db!.listCollections().toArray()).map(
      (c) => c.name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        LEGAL_ACCEPTANCES_COLLECTION,
        LEGAL_DOCUMENT_VERSIONS_COLLECTION,
      ]),
    );
    const index = (await indexes()).find(
      (i) => i.name === LEGAL_ACCEPTANCE_USER_INDEX_NAME,
    );
    expect(index?.key).toEqual({ userId: 1, acceptedAt: -1 });
    expect(index?.expireAfterSeconds).toBeUndefined();
  });

  it('idempotente, et refus d’un index homonyme différent sans l’écraser', async () => {
    const before = await indexes();
    await expect(ensureLegalAcceptanceIndexes(connection)).resolves.toBe(
      'already-present',
    );
    expect(await indexes()).toEqual(before);
    const collection = connection.db!.collection(LEGAL_ACCEPTANCES_COLLECTION);
    await collection.dropIndex(LEGAL_ACCEPTANCE_USER_INDEX_NAME);
    await collection.createIndex(
      { userId: 1, acceptedAt: -1 },
      { name: LEGAL_ACCEPTANCE_USER_INDEX_NAME, unique: true },
    );
    await expect(ensureLegalAcceptanceIndexes(connection)).rejects.toThrow();
    const index = (await indexes()).find(
      (i) => i.name === LEGAL_ACCEPTANCE_USER_INDEX_NAME,
    ) as { unique?: boolean } | undefined;
    expect(index?.unique).toBe(true);
  });
});
