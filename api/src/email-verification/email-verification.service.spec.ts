import {
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { createHash } from 'crypto';
import {
  EMAIL_VERIFICATION_COOLDOWN_MS,
  EMAIL_VERIFICATION_HOURLY_LIMIT,
  EMAIL_VERIFICATION_TTL_MS,
  EmailVerificationService,
} from './email-verification.service';
import { EmailDeliveryError, OutgoingEmail } from './email-sender';

const USER_ID = new Types.ObjectId('112233445566778899001122');
const NOW = new Date('2026-09-30T10:00:00.000Z');
const ORIGIN = 'https://app.example.com';

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

function tokenOf(email: OutgoingEmail): string {
  const match = /token=([^\s"&]+)/.exec(email.text);
  if (!match) throw new Error('no token in email');
  return decodeURIComponent(match[1]);
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    _id: USER_ID,
    name: 'Ada',
    email: 'ada@example.com',
    emailVerifiedAt: undefined,
    ...overrides,
  };
}

describe('EmailVerificationService (1-13A)', () => {
  let findOneResult: unknown;
  let updateResult: { modifiedCount: number };
  let userModel: { findOne: jest.Mock; updateOne: jest.Mock };
  let sender: { isConfigured: jest.Mock; send: jest.Mock };
  let env: Record<string, string | undefined>;
  let service: EmailVerificationService;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    findOneResult = makeUser();
    updateResult = { modifiedCount: 1 };
    userModel = {
      findOne: jest.fn(() => ({
        select: () => ({ exec: () => Promise.resolve(findOneResult) }),
      })),
      updateOne: jest.fn(() => ({ exec: () => Promise.resolve(updateResult) })),
    };
    sender = {
      isConfigured: jest.fn().mockReturnValue(true),
      send: jest.fn().mockResolvedValue(undefined),
    };
    env = { PUBLIC_APP_URL: ORIGIN };
    const config = { get: (key: string) => env[key] } as ConfigService;
    service = new EmailVerificationService(userModel as never, sender, config);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => warn.mockRestore());

  describe('issueForUser', () => {
    it('émet un token aléatoire (≥ 32 octets), ne stocke que son SHA-256, expiration 24 h', async () => {
      await expect(service.issueForUser(USER_ID.toString(), NOW)).resolves.toBe(
        'sent',
      );
      expect(sender.send).toHaveBeenCalledTimes(1);
      const email = sender.send.mock.calls[0][0] as OutgoingEmail;
      const token = tokenOf(email);
      expect(Buffer.from(token, 'base64url').length).toBeGreaterThanOrEqual(32);
      expect(email.to).toBe('ada@example.com');
      expect(email.text).toContain(`${ORIGIN}/auth/verify-email?token=`);
      expect(email.idempotencyKey).toBe(
        `email-verification-${USER_ID.toString()}-${NOW.getTime()}`,
      );

      const [filter, update] = userModel.updateOne.mock.calls[0] as [
        Record<string, unknown>,
        { $set: Record<string, unknown> },
      ];
      expect(filter).toEqual({
        _id: USER_ID,
        emailVerifiedAt: null,
        emailVerificationLastSentAt: { $exists: false },
      });
      expect(update.$set.emailVerificationTokenHash).toBe(sha256(token));
      expect(JSON.stringify(update)).not.toContain(token);
      expect(update.$set.emailVerificationExpiresAt).toEqual(
        new Date(NOW.getTime() + EMAIL_VERIFICATION_TTL_MS),
      );
      expect(update.$set.emailVerificationSendCount).toBe(1);
    });

    it('déjà vérifié → not_required, aucune écriture ni envoi', async () => {
      findOneResult = makeUser({ emailVerifiedAt: new Date() });
      await expect(service.issueForUser(USER_ID.toString(), NOW)).resolves.toBe(
        'not_required',
      );
      expect(userModel.updateOne).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('cooldown (< 60 s) → recently_sent, aucun envoi', async () => {
      findOneResult = makeUser({
        emailVerificationLastSentAt: new Date(
          NOW.getTime() - EMAIL_VERIFICATION_COOLDOWN_MS + 1,
        ),
      });
      await expect(service.issueForUser(USER_ID.toString(), NOW)).resolves.toBe(
        'recently_sent',
      );
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('plafond horaire atteint → recently_sent ; fenêtre expirée → compteur remis à zéro', async () => {
      const last = new Date(NOW.getTime() - 5 * 60 * 1000);
      findOneResult = makeUser({
        emailVerificationLastSentAt: last,
        emailVerificationWindowStartedAt: new Date(
          NOW.getTime() - 30 * 60 * 1000,
        ),
        emailVerificationSendCount: EMAIL_VERIFICATION_HOURLY_LIMIT,
      });
      await expect(service.issueForUser(USER_ID.toString(), NOW)).resolves.toBe(
        'recently_sent',
      );
      expect(sender.send).not.toHaveBeenCalled();

      findOneResult = makeUser({
        emailVerificationLastSentAt: last,
        emailVerificationWindowStartedAt: new Date(
          NOW.getTime() - 61 * 60 * 1000,
        ),
        emailVerificationSendCount: EMAIL_VERIFICATION_HOURLY_LIMIT,
      });
      await expect(service.issueForUser(USER_ID.toString(), NOW)).resolves.toBe(
        'sent',
      );
      const [filter, update] = userModel.updateOne.mock.calls[0] as [
        Record<string, unknown>,
        { $set: Record<string, unknown> },
      ];
      // Verrou optimiste sur la dernière émission lue.
      expect(filter.emailVerificationLastSentAt).toEqual(last);
      expect(update.$set.emailVerificationSendCount).toBe(1);
      expect(update.$set.emailVerificationWindowStartedAt).toEqual(NOW);
    });

    it('émission concurrente perdue (verrou optimiste) → recently_sent, aucun envoi', async () => {
      updateResult = { modifiedCount: 0 };
      await expect(service.issueForUser(USER_ID.toString(), NOW)).resolves.toBe(
        'recently_sent',
      );
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('échec fournisseur → failed, journal sans adresse, token ni URL', async () => {
      sender.send.mockRejectedValue(new EmailDeliveryError('rejected', 422));
      await expect(service.issueForUser(USER_ID.toString(), NOW)).resolves.toBe(
        'failed',
      );
      const logged = warn.mock.calls.flat().join(' ');
      expect(logged).toContain('rejected (HTTP 422)');
      expect(logged).not.toContain('ada@example.com');
      expect(logged).not.toContain(ORIGIN);
      expect(logged).not.toContain('token');
    });

    it.each([
      ['PUBLIC_APP_URL absente', undefined, true],
      ['PUBLIC_APP_URL invalide', 'https://app.example.com/chemin', true],
      ['fournisseur non configuré', ORIGIN, false],
    ])('%s → failed sans lecture ni écriture', async (_l, url, configured) => {
      env.PUBLIC_APP_URL = url;
      sender.isConfigured.mockReturnValue(configured);
      await expect(service.issueForUser(USER_ID.toString(), NOW)).resolves.toBe(
        'failed',
      );
      expect(userModel.findOne).not.toHaveBeenCalled();
      expect(userModel.updateOne).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    });
  });

  describe('requestByEmail', () => {
    it('adresse normalisée ; envoi retourné sans être attendu', async () => {
      let release: () => void = () => undefined;
      sender.send.mockImplementation(
        () => new Promise<void>((resolve) => (release = resolve)),
      );
      const { delivery } = await service.requestByEmail(
        '  Ada@Example.COM ',
        NOW,
      );
      expect(userModel.findOne).toHaveBeenCalledWith({
        email: 'ada@example.com',
      });
      release();
      await expect(delivery).resolves.toBeUndefined();
    });

    it.each([
      ['compte inexistant', null],
      ['déjà vérifié', makeUser({ emailVerifiedAt: new Date() })],
    ])('%s → aucun envoi, même forme de résultat', async (_l, user) => {
      findOneResult = user;
      const { delivery } = await service.requestByEmail('x@example.com', NOW);
      await expect(delivery).resolves.toBeUndefined();
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('échec fournisseur → promesse résolue (réponse neutre préservée)', async () => {
      sender.send.mockRejectedValue(new EmailDeliveryError('timeout'));
      const { delivery } = await service.requestByEmail('ada@example.com', NOW);
      await expect(delivery).resolves.toBeUndefined();
    });

    it('configuration globale absente → 503 contrôlé AVANT toute lecture', async () => {
      sender.isConfigured.mockReturnValue(false);
      const error: unknown = await service
        .requestByEmail('ada@example.com', NOW)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(
        (error as ServiceUnavailableException).getResponse(),
      ).toMatchObject({ code: 'EMAIL_DELIVERY_UNAVAILABLE' });
      expect(userModel.findOne).not.toHaveBeenCalled();
    });
  });

  describe('confirm', () => {
    it('mise à jour atomique unique : hash + expiration + non vérifié', async () => {
      await service.confirm('raw-token', NOW);
      expect(userModel.updateOne).toHaveBeenCalledTimes(1);
      expect(userModel.updateOne).toHaveBeenCalledWith(
        {
          emailVerificationTokenHash: sha256('raw-token'),
          emailVerificationExpiresAt: { $gt: NOW },
          emailVerifiedAt: null,
        },
        {
          $set: { emailVerifiedAt: NOW },
          $unset: {
            emailVerificationTokenHash: 1,
            emailVerificationExpiresAt: 1,
          },
        },
      );
    });

    it.each([
      ['absent', undefined],
      ['vide', ''],
      ['non-chaîne', 42],
      ['objet', { $ne: null }],
      ['trop long', 'x'.repeat(513)],
    ])('token %s → 400 stable sans requête', async (_l, token) => {
      const error: unknown = await service
        .confirm(token, NOW)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'EMAIL_VERIFICATION_INVALID_OR_EXPIRED',
      });
      expect(userModel.updateOne).not.toHaveBeenCalled();
    });

    it('inconnu, expiré, déjà utilisé ou compte déjà vérifié → même 400', async () => {
      updateResult = { modifiedCount: 0 };
      await expect(service.confirm('raw-token', NOW)).rejects.toMatchObject({
        response: { code: 'EMAIL_VERIFICATION_INVALID_OR_EXPIRED' },
      });
    });
  });
});
