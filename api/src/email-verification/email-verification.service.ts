import { recipientLocale, type AppLocale } from '../common/i18n/locale';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createHash, randomBytes } from 'crypto';
import { User, UserDocument } from '../users/schemas/user.schema';
import { parsePublicAppOrigin } from '../organizations/invitation-link';
import {
  EMAIL_SENDER,
  EmailDeliveryError,
  type EmailSender,
} from './email-sender';
import {
  buildEmailVerificationUrl,
  buildVerificationEmail,
} from './verification-email';

/** Code stable de toute confirmation refusée (absent/invalide/expiré/utilisé). */
export const EMAIL_VERIFICATION_INVALID_OR_EXPIRED =
  'EMAIL_VERIFICATION_INVALID_OR_EXPIRED';
/** Code stable du login / des routes protégées pour un compte non vérifié. */
export const EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED';
/** Configuration serveur d'envoi absente/invalide (indépendant de l'adresse). */
export const EMAIL_DELIVERY_UNAVAILABLE = 'EMAIL_DELIVERY_UNAVAILABLE';

export const EMAIL_NOT_VERIFIED_MESSAGE =
  'Confirmez votre adresse email pour accéder à votre compte.';

/** Durée de validité d'un lien. */
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
/** Délai minimal entre deux émissions pour un même compte. */
export const EMAIL_VERIFICATION_COOLDOWN_MS = 60 * 1000;
/** Plafond d'émissions par compte et par fenêtre glissante d'une heure. */
export const EMAIL_VERIFICATION_HOURLY_LIMIT = 5;
export const EMAIL_VERIFICATION_WINDOW_MS = 60 * 60 * 1000;
/** Borne défensive de la longueur d'un token reçu (base64url de 32 octets = 43). */
const MAX_TOKEN_LENGTH = 512;

/**
 * Résultat d'une émission rattachée à une création de compte :
 * - `sent` : le fournisseur a accepté l'envoi (PAS une vérification) ;
 * - `failed` : compte conservé, non vérifié, renvoi possible plus tard ;
 * - `recently_sent` : cooldown ou plafond horaire, aucun nouvel envoi ;
 * - `not_required` : adresse déjà vérifiée.
 */
export type EmailVerificationDelivery =
  'sent' | 'failed' | 'recently_sent' | 'not_required';

type IssuanceClaim =
  | { kind: 'none' | 'verified' | 'throttled' }
  | {
      kind: 'claimed';
      userId: string;
      email: string;
      name: string;
      locale: AppLocale;
      rawToken: string;
      idempotencyKey: string;
    };

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 1-13A — Vérification de l'adresse email d'un compte utilisateur.
 *
 * La vérification appartient au User : aucune lecture ni écriture de
 * membership, rôle, permission ou organisation.
 */
@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger('EmailVerification');

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    private readonly config: ConfigService,
  ) {}

  private appOrigin(): string | null {
    return parsePublicAppOrigin(this.config.get<string>('PUBLIC_APP_URL'));
  }

  /** Configuration globale d'envoi (fournisseur + origine publique). */
  isDeliveryConfigured(): boolean {
    return this.appOrigin() !== null && this.sender.isConfigured();
  }

  /**
   * Émission après une création de compte (inscription, invitation), APRÈS
   * le commit de la transaction. Un échec ne supprime ni ne vérifie le
   * compte : il reste non vérifié et peut redemander un lien.
   */
  async issueForUser(
    userId: string,
    now: Date = new Date(),
  ): Promise<EmailVerificationDelivery> {
    if (!this.isDeliveryConfigured()) {
      this.logger.warn('Email verification: delivery is not configured');
      return 'failed';
    }
    const claim = await this.claimIssuance(
      { _id: new Types.ObjectId(userId) },
      now,
    );
    switch (claim.kind) {
      case 'claimed':
        return (await this.deliver(claim)) ? 'sent' : 'failed';
      case 'verified':
        return 'not_required';
      case 'throttled':
        return 'recently_sent';
      default:
        return 'failed';
    }
  }

  /**
   * Demande publique de (ré)envoi. Réponse neutre dans tous les cas (compte
   * inexistant, déjà vérifié, cooldown, échec fournisseur) : l'appelant ne
   * reçoit que la promesse d'envoi, à ne PAS attendre dans la réponse HTTP
   * (aucun écart de temps observable selon l'existence du compte).
   * Seule une configuration globalement absente lève une erreur contrôlée,
   * vérifiée AVANT toute lecture de l'adresse.
   */
  async requestByEmail(
    email: string,
    now: Date = new Date(),
  ): Promise<{ delivery: Promise<void> }> {
    if (!this.isDeliveryConfigured()) {
      this.logger.warn('Email verification: delivery is not configured');
      throw new ServiceUnavailableException({
        code: EMAIL_DELIVERY_UNAVAILABLE,
        message:
          "L'envoi d'emails est momentanément indisponible. Réessayez plus tard.",
      });
    }
    const normalized = email.trim().toLowerCase();
    const claim = await this.claimIssuance({ email: normalized }, now);
    if (claim.kind !== 'claimed') {
      return { delivery: Promise.resolve() };
    }
    return {
      delivery: this.deliver(claim).then(
        () => undefined,
        () => undefined,
      ),
    };
  }

  /**
   * Consommation atomique à usage unique : une seule mise à jour
   * conditionnelle (hash + expiration + état courant non vérifié) renseigne
   * `emailVerifiedAt` et retire le hash. Aucun JWT, aucune connexion.
   */
  async confirm(token: unknown, now: Date = new Date()): Promise<void> {
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      token.length > MAX_TOKEN_LENGTH
    ) {
      throw this.invalidOrExpired();
    }
    const result = await this.userModel
      .updateOne(
        {
          emailVerificationTokenHash: hashToken(token),
          emailVerificationExpiresAt: { $gt: now },
          emailVerifiedAt: null,
        },
        {
          $set: { emailVerifiedAt: now },
          $unset: {
            emailVerificationTokenHash: 1,
            emailVerificationExpiresAt: 1,
          },
        },
      )
      .exec();
    if (result.modifiedCount !== 1) {
      throw this.invalidOrExpired();
    }
  }

  /**
   * Réserve une émission (cooldown + plafond horaire) puis remplace le lien
   * précédent. Verrou optimiste sur `emailVerificationLastSentAt` : de deux
   * demandes concurrentes lisant le même état, une seule met à jour le
   * document et envoie ; l'autre est traitée comme un cooldown.
   */
  private async claimIssuance(
    filter: { _id: Types.ObjectId } | { email: string },
    now: Date,
  ): Promise<IssuanceClaim> {
    const user = await this.userModel
      .findOne(filter)
      .select(
        '+emailVerificationLastSentAt +emailVerificationWindowStartedAt +emailVerificationSendCount',
      )
      .exec();
    if (!user) return { kind: 'none' };
    if (user.emailVerifiedAt) return { kind: 'verified' };

    const lastSentAt = user.emailVerificationLastSentAt;
    if (
      lastSentAt &&
      now.getTime() - lastSentAt.getTime() < EMAIL_VERIFICATION_COOLDOWN_MS
    ) {
      return { kind: 'throttled' };
    }

    let windowStartedAt = user.emailVerificationWindowStartedAt;
    let sendCount = user.emailVerificationSendCount ?? 0;
    if (
      !windowStartedAt ||
      now.getTime() - windowStartedAt.getTime() >= EMAIL_VERIFICATION_WINDOW_MS
    ) {
      windowStartedAt = now;
      sendCount = 0;
    }
    if (sendCount >= EMAIL_VERIFICATION_HOURLY_LIMIT) {
      return { kind: 'throttled' };
    }

    const rawToken = randomBytes(32).toString('base64url');
    const result = await this.userModel
      .updateOne(
        {
          _id: user._id,
          emailVerifiedAt: null,
          emailVerificationLastSentAt: lastSentAt ?? { $exists: false },
        },
        {
          $set: {
            emailVerificationTokenHash: hashToken(rawToken),
            emailVerificationExpiresAt: new Date(
              now.getTime() + EMAIL_VERIFICATION_TTL_MS,
            ),
            emailVerificationLastSentAt: now,
            emailVerificationWindowStartedAt: windowStartedAt,
            emailVerificationSendCount: sendCount + 1,
          },
        },
      )
      .exec();
    if (result.modifiedCount !== 1) {
      return { kind: 'throttled' };
    }

    const userId = user._id.toString();
    return {
      kind: 'claimed',
      userId,
      email: user.email,
      name: user.name,
      // 1-16G : langue du destinataire (repli français).
      locale: recipientLocale(user.locale),
      rawToken,
      idempotencyKey: `email-verification-${userId}-${now.getTime()}`,
    };
  }

  /** Envoi unique (aucune relance) ; `false` en cas d'échec, déjà journalisé. */
  private async deliver(
    claim: Extract<IssuanceClaim, { kind: 'claimed' }>,
  ): Promise<boolean> {
    const origin = this.appOrigin();
    if (!origin) {
      this.logger.warn('Email verification: delivery is not configured');
      return false;
    }
    const content = buildVerificationEmail(
      claim.name,
      buildEmailVerificationUrl(origin, claim.rawToken),
      claim.locale,
    );
    try {
      await this.sender.send({
        to: claim.email,
        subject: content.subject,
        html: content.html,
        text: content.text,
        idempotencyKey: claim.idempotencyKey,
      });
      return true;
    } catch (err) {
      // Raison courte uniquement : jamais d'adresse, de token, d'URL, de
      // contenu ni de réponse brute du fournisseur.
      const reason =
        err instanceof EmailDeliveryError
          ? `${err.reason}${err.providerStatus ? ` (HTTP ${err.providerStatus})` : ''}`
          : 'unexpected';
      this.logger.warn(`Email verification: delivery failed — ${reason}`);
      return false;
    }
  }

  private invalidOrExpired(): BadRequestException {
    return new BadRequestException({
      code: EMAIL_VERIFICATION_INVALID_OR_EXPIRED,
      message: 'Ce lien de confirmation est invalide ou a expiré.',
    });
  }
}
