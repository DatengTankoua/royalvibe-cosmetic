import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { USER_NAME_MAX_LENGTH } from '../../common/validation/name-rules';
import { APP_LOCALES, type AppLocale } from '../../common/i18n/locale';

export type UserDocument = HydratedDocument<User>;

export enum UserRole {
  ADMIN = 'admin',
  SELLER = 'seller',
}

@Schema({ timestamps: true })
export class User {
  _id: Types.ObjectId;

  /**
   * 1-12C/1-12D : 1 à 20 caractères après trim (défense en profondeur ; le DTO
   * reste la première barrière). Aucune migration : un document historique
   * plus long reste lisible tel quel.
   */
  @Prop({
    required: true,
    trim: true,
    minlength: 1,
    maxlength: USER_NAME_MAX_LENGTH,
  })
  name: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ required: true, select: false })
  password: string;

  @Prop({ enum: UserRole, default: UserRole.SELLER })
  role: UserRole;

  /**
   * 1-16G : langue préférée du compte (`fr` | `en`) pour les e-mails et les
   * notifications push qui lui sont destinés. Absente (comptes antérieurs,
   * jamais réécrits) = français. Renseignée à la création du compte (langue
   * des conditions acceptées) puis par le choix « Français / English ».
   */
  @Prop({ type: String, enum: APP_LOCALES, default: undefined })
  locale?: AppLocale;

  /**
   * 1-13A : preuve d'accès à la boîte mail. Absent ou `null` = non vérifiée
   * (comptes historiques compris, jamais migrés automatiquement). Renseigné
   * UNIQUEMENT par la consommation d'un lien de vérification valide
   * (`EmailVerificationService.confirm`), jamais depuis une requête client.
   */
  @Prop({ type: Date, default: undefined })
  emailVerifiedAt?: Date | null;

  // 1-13A — champs internes de vérification : `select: false`, jamais
  // exposés (réponses, principal JWT/Socket.IO). Seul le hash SHA-256 du
  // token est stocké ; le token brut n'existe que dans l'email envoyé.
  @Prop({ select: false, index: { sparse: true } })
  emailVerificationTokenHash?: string;

  @Prop({ type: Date, select: false })
  emailVerificationExpiresAt?: Date;

  /** Dernière émission (cooldown et verrou optimiste anti-concurrence). */
  @Prop({ type: Date, select: false })
  emailVerificationLastSentAt?: Date;

  /** Début de la fenêtre horaire du plafond d'émissions. */
  @Prop({ type: Date, select: false })
  emailVerificationWindowStartedAt?: Date;

  @Prop({ type: Number, select: false })
  emailVerificationSendCount?: number;

  /**
   * 1-13B : version de session serveur. Absente = 0 (comptes historiques).
   * Incrémentée par une réinitialisation de mot de passe : tout JWT portant
   * une version antérieure est refusé (`SESSION_REVOKED`).
   */
  @Prop({ type: Number, select: false })
  authVersion?: number;

  // 1-13B — réinitialisation du mot de passe : champs internes, distincts de
  // la vérification d'email, jamais exposés. SHA-256 du token uniquement.
  // Aucun index TTL (les champs expirent logiquement, le User reste).
  @Prop({ select: false, index: { sparse: true } })
  passwordResetTokenHash?: string;

  @Prop({ type: Date, select: false })
  passwordResetExpiresAt?: Date;

  @Prop({ type: Date, select: false })
  passwordResetLastSentAt?: Date;

  @Prop({ type: Date, select: false })
  passwordResetWindowStartedAt?: Date;

  @Prop({ type: Number, select: false })
  passwordResetSendCount?: number;
}

export const UserSchema = SchemaFactory.createForClass(User);
