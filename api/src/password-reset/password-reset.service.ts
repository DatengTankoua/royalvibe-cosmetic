import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash, randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { User, UserDocument } from '../users/schemas/user.schema';
import { parsePublicAppOrigin } from '../organizations/invitation-link';
import { SocketRegistryService } from '../organizations/socket-registry.service';
import {
  EMAIL_SENDER,
  EmailDeliveryError,
  type EmailSender,
  type OutgoingEmail,
} from '../email-verification/email-sender';
import { EMAIL_DELIVERY_UNAVAILABLE } from '../email-verification/email-verification.service';
import {
  currentSessionVersion,
  sessionVersionFilter,
} from '../auth/session-version';
import {
  buildPasswordChangedEmail,
  buildPasswordResetEmail,
  buildPasswordResetUrl,
} from './password-reset-email';

/** Code stable de toute confirmation refusée (absent/invalide/expiré/utilisé). */
export const PASSWORD_RESET_INVALID_OR_EXPIRED =
  'PASSWORD_RESET_INVALID_OR_EXPIRED';

export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
export const PASSWORD_RESET_COOLDOWN_MS = 60 * 1000;
export const PASSWORD_RESET_HOURLY_LIMIT = 5;
export const PASSWORD_RESET_WINDOW_MS = 60 * 60 * 1000;
/** Même coût bcrypt que l'inscription et l'acceptation d'invitation. */
const BCRYPT_ROUNDS = 10;
const MAX_TOKEN_LENGTH = 512;

const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

interface ResetClaim {
  userId: string;
  email: string;
  name: string;
  rawToken: string;
  idempotencyKey: string;
}

/**
 * 1-13B — Réinitialisation du mot de passe par email.
 *
 * Ne touche jamais à `emailVerifiedAt` ni aux champs de vérification, ni
 * aux memberships, permissions, organisations ou ventes. Une demande ne
 * modifie ni le mot de passe ni la version de session.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger('PasswordReset');

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    private readonly config: ConfigService,
    private readonly socketRegistry: SocketRegistryService,
  ) {}

  private appOrigin(): string | null {
    return parsePublicAppOrigin(this.config.get<string>('PUBLIC_APP_URL'));
  }

  /**
   * Demande publique. Seule une configuration d'envoi globalement absente
   * lève une erreur (avant toute lecture). Tout le reste — recherche du
   * compte, réservation, envoi — se déroule APRÈS la réponse : la durée de
   * réponse ne dépend pas de l'existence du compte.
   */
  requestByEmail(
    email: string,
    now: Date = new Date(),
  ): { delivery: Promise<void> } {
    if (this.appOrigin() === null || !this.sender.isConfigured()) {
      this.logger.warn('Password reset: delivery is not configured');
      throw new ServiceUnavailableException({
        code: EMAIL_DELIVERY_UNAVAILABLE,
        message:
          "L'envoi d'emails est momentanément indisponible. Réessayez plus tard.",
      });
    }
    const normalized = email.trim().toLowerCase();
    const delivery = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.claim(normalized, now))
      .then((claim) => (claim ? this.deliverReset(claim) : undefined))
      .catch(() => {
        this.logger.warn('Password reset: request processing failed');
      });
    return { delivery };
  }

  /**
   * 1. candidat + expiration vérifiés AVANT le hachage coûteux (un échec ne
   *    consomme rien) ; 2. hachage ; 3. UNE écriture atomique qui revérifie
   *    token, expiration et version de session, remplace le mot de passe,
   *    incrémente la version et retire le hash du lien. Deux confirmations
   *    concurrentes : une seule écriture réussit.
   */
  async confirm(
    token: unknown,
    password: string,
    now: Date = new Date(),
  ): Promise<void> {
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      token.length > MAX_TOKEN_LENGTH
    ) {
      throw this.invalidOrExpired();
    }
    const tokenHash = hashToken(token);
    const candidate = await this.userModel
      .findOne({
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: { $gt: now },
      })
      .select('+authVersion')
      .exec();
    if (!candidate) throw this.invalidOrExpired();

    const version = currentSessionVersion(candidate);
    const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = await this.userModel
      .updateOne(
        {
          _id: candidate._id,
          passwordResetTokenHash: tokenHash,
          passwordResetExpiresAt: { $gt: now },
          authVersion: sessionVersionFilter(version),
        },
        {
          $set: { password: hashed, authVersion: version + 1 },
          $unset: { passwordResetTokenHash: 1, passwordResetExpiresAt: 1 },
        },
      )
      .exec();
    if (result.modifiedCount !== 1) throw this.invalidOrExpired();

    // Après l'écriture : leurs échecs n'annulent rien et ne transforment pas
    // la réinitialisation appliquée en échec apparent.
    const userId = candidate._id.toString();
    try {
      this.socketRegistry.disconnectUserSessionsBefore(userId, version + 1);
    } catch {
      this.logger.warn('Password reset: socket disconnection failed');
    }
    void this.notifyPasswordChanged(
      userId,
      candidate.email,
      candidate.name,
      version + 1,
    );
  }

  /**
   * Réservation : cooldown, plafond horaire, puis écriture conditionnée sur
   * la dernière émission lue ET la version de session lue — une demande
   * préparée avant une réinitialisation ne recrée pas de lien ensuite.
   */
  private async claim(email: string, now: Date): Promise<ResetClaim | null> {
    const user = await this.userModel
      .findOne({ email })
      .select(
        '+authVersion +passwordResetLastSentAt +passwordResetWindowStartedAt +passwordResetSendCount',
      )
      .exec();
    if (!user) return null;

    const lastSentAt = user.passwordResetLastSentAt;
    if (
      lastSentAt &&
      now.getTime() - lastSentAt.getTime() < PASSWORD_RESET_COOLDOWN_MS
    ) {
      return null;
    }
    let windowStartedAt = user.passwordResetWindowStartedAt;
    let sendCount = user.passwordResetSendCount ?? 0;
    if (
      !windowStartedAt ||
      now.getTime() - windowStartedAt.getTime() >= PASSWORD_RESET_WINDOW_MS
    ) {
      windowStartedAt = now;
      sendCount = 0;
    }
    if (sendCount >= PASSWORD_RESET_HOURLY_LIMIT) return null;

    const rawToken = randomBytes(32).toString('base64url');
    const result = await this.userModel
      .updateOne(
        {
          _id: user._id,
          authVersion: sessionVersionFilter(currentSessionVersion(user)),
          passwordResetLastSentAt: lastSentAt ?? { $exists: false },
        },
        {
          $set: {
            passwordResetTokenHash: hashToken(rawToken),
            passwordResetExpiresAt: new Date(
              now.getTime() + PASSWORD_RESET_TTL_MS,
            ),
            passwordResetLastSentAt: now,
            passwordResetWindowStartedAt: windowStartedAt,
            passwordResetSendCount: sendCount + 1,
          },
        },
      )
      .exec();
    if (result.modifiedCount !== 1) return null;

    const userId = user._id.toString();
    return {
      userId,
      email: user.email,
      name: user.name,
      rawToken,
      idempotencyKey: `password-reset-${userId}-${now.getTime()}`,
    };
  }

  private async deliverReset(claim: ResetClaim): Promise<void> {
    const origin = this.appOrigin();
    if (!origin) {
      this.logger.warn('Password reset: delivery is not configured');
      return;
    }
    const content = buildPasswordResetEmail(
      claim.name,
      buildPasswordResetUrl(origin, claim.rawToken),
    );
    await this.send(
      {
        to: claim.email,
        ...content,
        idempotencyKey: claim.idempotencyKey,
      },
      'reset link',
    );
  }

  private async notifyPasswordChanged(
    userId: string,
    email: string,
    name: string,
    version: number,
  ): Promise<void> {
    if (!this.sender.isConfigured()) {
      this.logger.warn('Password reset: notification not configured');
      return;
    }
    await this.send(
      {
        to: email,
        ...buildPasswordChangedEmail(name),
        idempotencyKey: `password-changed-${userId}-${version}`,
      },
      'change notification',
    );
  }

  /** Envoi unique (aucune relance) ; journal réduit à la raison. */
  private async send(email: OutgoingEmail, kind: string): Promise<void> {
    try {
      await this.sender.send(email);
    } catch (err) {
      const reason =
        err instanceof EmailDeliveryError
          ? `${err.reason}${err.providerStatus ? ` (HTTP ${err.providerStatus})` : ''}`
          : 'unexpected';
      this.logger.warn(`Password reset: ${kind} delivery failed — ${reason}`);
    }
  }

  private invalidOrExpired(): BadRequestException {
    return new BadRequestException({
      code: PASSWORD_RESET_INVALID_OR_EXPIRED,
      message: 'Ce lien de réinitialisation est invalide ou a expiré.',
    });
  }
}
