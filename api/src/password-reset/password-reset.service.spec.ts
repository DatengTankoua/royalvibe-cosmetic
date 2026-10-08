import {
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { createHash } from 'crypto';
import * as bcrypt from 'bcryptjs';
import {
  PASSWORD_RESET_COOLDOWN_MS,
  PASSWORD_RESET_HOURLY_LIMIT,
  PASSWORD_RESET_TTL_MS,
  PasswordResetService,
} from './password-reset.service';
import {
  EmailDeliveryError,
  OutgoingEmail,
} from '../email-verification/email-sender';
import { PASSWORD_CHANGED_SUBJECT } from './password-reset-email';

const USER_ID = new Types.ObjectId('112233445566778899001122');
const NOW = new Date('2026-10-01T10:00:00.000Z');
const ORIGIN = 'https://app.example.com';

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

function tokenOf(email: OutgoingEmail): string {
  const match = /\/auth\/reset-password\?token=([^\s"&]+)/.exec(email.text);
  if (!match) throw new Error('no token in email');
  return decodeURIComponent(match[1]);
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    _id: USER_ID,
    name: 'Ada',
    email: 'ada@example.com',
    ...overrides,
  };
}

describe('PasswordResetService (1-13B)', () => {
  let findOneResult: unknown;
  let updateResult: { modifiedCount: number };
  let userModel: { findOne: jest.Mock; updateOne: jest.Mock };
  let sender: { isConfigured: jest.Mock; send: jest.Mock };
  let registry: { disconnectUserSessionsBefore: jest.Mock };
  let env: Record<string, string | undefined>;
  let service: PasswordResetService;
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
    registry = { disconnectUserSessionsBefore: jest.fn().mockReturnValue(0) };
    env = { PUBLIC_APP_URL: ORIGIN };
    const config = { get: (key: string) => env[key] } as ConfigService;
    service = new PasswordResetService(
      userModel as never,
      sender,
      config,
      registry as never,
    );
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => warn.mockRestore());

  const sentEmail = (index = 0) =>
    sender.send.mock.calls[index][0] as OutgoingEmail;
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  describe('requestByEmail', () => {
    it('répond avant toute recherche ; lien 1 h, SHA-256 seul, version de session dans la réservation', async () => {
      const { delivery } = service.requestByEmail('  Ada@Example.COM ', NOW);
      // Aucune lecture synchrone : la durée de réponse ne dépend pas du compte.
      expect(userModel.findOne).not.toHaveBeenCalled();
      await delivery;
      expect(userModel.findOne).toHaveBeenCalledWith({
        email: 'ada@example.com',
      });

      const email = sentEmail();
      const token = tokenOf(email);
      expect(Buffer.from(token, 'base64url').length).toBeGreaterThanOrEqual(32);
      expect(email.text).toContain(`${ORIGIN}/auth/reset-password?token=`);
      expect(email.idempotencyKey).toBe(
        `password-reset-${USER_ID.toString()}-${NOW.getTime()}`,
      );
      const [filter, update] = userModel.updateOne.mock.calls[0] as [
        Record<string, unknown>,
        { $set: Record<string, unknown> },
      ];
      expect(filter).toEqual({
        _id: USER_ID,
        authVersion: { $in: [null, 0] },
        passwordResetLastSentAt: { $exists: false },
      });
      expect(update.$set.passwordResetTokenHash).toBe(sha256(token));
      expect(update.$set.passwordResetExpiresAt).toEqual(
        new Date(NOW.getTime() + PASSWORD_RESET_TTL_MS),
      );
      expect(JSON.stringify(update)).not.toContain(token);
      // Une demande ne touche ni mot de passe, ni version, ni vérification.
      expect(Object.keys(update.$set)).not.toEqual(
        expect.arrayContaining(['password']),
      );
      expect(update.$set).not.toHaveProperty('authVersion');
      expect(update.$set).not.toHaveProperty('emailVerifiedAt');
    });

    it('version de session courante > 0 → réservation conditionnée sur cette version', async () => {
      findOneResult = makeUser({ authVersion: 3 });
      await service.requestByEmail('ada@example.com', NOW).delivery;
      const [filter] = userModel.updateOne.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(filter.authVersion).toBe(3);
    });

    it('compte inexistant → aucune écriture ni envoi', async () => {
      findOneResult = null;
      await service.requestByEmail('nobody@example.com', NOW).delivery;
      expect(userModel.updateOne).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('cooldown, plafond horaire et réservation concurrente perdue → aucun envoi', async () => {
      findOneResult = makeUser({
        passwordResetLastSentAt: new Date(
          NOW.getTime() - PASSWORD_RESET_COOLDOWN_MS + 1,
        ),
      });
      await service.requestByEmail('ada@example.com', NOW).delivery;
      findOneResult = makeUser({
        passwordResetLastSentAt: new Date(NOW.getTime() - 5 * 60_000),
        passwordResetWindowStartedAt: new Date(NOW.getTime() - 10 * 60_000),
        passwordResetSendCount: PASSWORD_RESET_HOURLY_LIMIT,
      });
      await service.requestByEmail('ada@example.com', NOW).delivery;
      expect(userModel.updateOne).not.toHaveBeenCalled();

      findOneResult = makeUser();
      updateResult = { modifiedCount: 0 };
      await service.requestByEmail('ada@example.com', NOW).delivery;
      expect(userModel.updateOne).toHaveBeenCalledTimes(1);
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('échec fournisseur → promesse résolue, journal sans adresse ni URL', async () => {
      sender.send.mockRejectedValue(new EmailDeliveryError('timeout'));
      await expect(
        service.requestByEmail('ada@example.com', NOW).delivery,
      ).resolves.toBeUndefined();
      const logged = warn.mock.calls.flat().join(' ');
      expect(logged).toContain('reset link delivery failed — timeout');
      expect(logged).not.toContain('ada@');
      expect(logged).not.toContain(ORIGIN);
    });

    it.each([
      ['PUBLIC_APP_URL absente', undefined, true],
      ['fournisseur non configuré', ORIGIN, false],
    ])('%s → 503 avant toute recherche', (_l, url, configured) => {
      env.PUBLIC_APP_URL = url;
      sender.isConfigured.mockReturnValue(configured);
      let error: unknown;
      try {
        service.requestByEmail('ada@example.com', NOW);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(
        (error as ServiceUnavailableException).getResponse(),
      ).toMatchObject({ code: 'EMAIL_DELIVERY_UNAVAILABLE' });
      expect(userModel.findOne).not.toHaveBeenCalled();
    });
  });

  describe('confirm', () => {
    it('écriture atomique unique : token + expiration + version revérifiés, mot de passe haché, version incrémentée', async () => {
      findOneResult = makeUser({ authVersion: 2 });
      await service.confirm('raw-token', 'nouveau mot de passe ', NOW);

      expect(userModel.findOne).toHaveBeenCalledWith({
        passwordResetTokenHash: sha256('raw-token'),
        passwordResetExpiresAt: { $gt: NOW },
      });
      const [filter, update] = userModel.updateOne.mock.calls[0] as [
        Record<string, unknown>,
        { $set: { password: string; authVersion: number }; $unset: object },
      ];
      expect(filter).toEqual({
        _id: USER_ID,
        passwordResetTokenHash: sha256('raw-token'),
        passwordResetExpiresAt: { $gt: NOW },
        authVersion: 2,
      });
      expect(update.$set.authVersion).toBe(3);
      // Jamais trimé : l'espace final fait partie du mot de passe.
      expect(
        await bcrypt.compare('nouveau mot de passe ', update.$set.password),
      ).toBe(true);
      expect(
        await bcrypt.compare('nouveau mot de passe', update.$set.password),
      ).toBe(false);
      expect(update.$unset).toEqual({
        passwordResetTokenHash: 1,
        passwordResetExpiresAt: 1,
      });
      expect(JSON.stringify(update)).not.toMatch(/emailVerif/);

      expect(registry.disconnectUserSessionsBefore).toHaveBeenCalledWith(
        USER_ID.toString(),
        3,
      );
      await settle();
      const notification = sentEmail();
      expect(notification.subject).toBe(PASSWORD_CHANGED_SUBJECT);
      expect(notification.idempotencyKey).toBe(
        `password-changed-${USER_ID.toString()}-3`,
      );
      expect(notification.text).not.toMatch(/token|nouveau mot de passe /);
    });

    it.each([
      ['absent', undefined],
      ['vide', ''],
      ['non-chaîne', 42],
      ['objet', { $ne: null }],
      ['trop long', 'x'.repeat(513)],
    ])('token %s → 400 stable sans requête', async (_l, token) => {
      const error: unknown = await service
        .confirm(token, 'secret-123', NOW)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'PASSWORD_RESET_INVALID_OR_EXPIRED',
        message: 'Ce lien de réinitialisation est invalide ou a expiré.',
      });
      expect(userModel.findOne).not.toHaveBeenCalled();
    });

    it('inconnu/expiré/utilisé → 400 avant tout hachage ni écriture', async () => {
      findOneResult = null;
      await expect(
        service.confirm('raw-token', 'secret-123', NOW),
      ).rejects.toMatchObject({
        response: { code: 'PASSWORD_RESET_INVALID_OR_EXPIRED' },
      });
      expect(userModel.updateOne).not.toHaveBeenCalled();
      expect(registry.disconnectUserSessionsBefore).not.toHaveBeenCalled();
    });

    it('écriture concurrente perdue → 400, aucune déconnexion ni notification', async () => {
      updateResult = { modifiedCount: 0 };
      await expect(
        service.confirm('raw-token', 'secret-123', NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
      await settle();
      expect(registry.disconnectUserSessionsBefore).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('échecs après écriture (sockets, notification) → réinitialisation tout de même réussie', async () => {
      registry.disconnectUserSessionsBefore.mockImplementation(() => {
        throw new Error('boom');
      });
      sender.send.mockRejectedValue(new EmailDeliveryError('rejected', 500));
      await expect(
        service.confirm('raw-token', 'secret-123', NOW),
      ).resolves.toBeUndefined();
      await settle();
      expect(warn.mock.calls.flat().join(' ')).toContain(
        'change notification delivery failed',
      );
    });
  });
});
