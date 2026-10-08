import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export const SUPPORT_REQUESTS_COLLECTION = 'support_requests';

export enum SupportRequestStatus {
  PENDING = 'pending',
  SENDING = 'sending',
  SENT = 'sent',
  /** Le transport n'a pas répondu (délai, réseau, 5xx, 409) : envoi incertain. */
  UNKNOWN = 'unknown',
  /** Refus certain du transport ou configuration absente : non envoyé. */
  FAILED = 'failed',
}

/** Instantané du contexte établi À LA CRÉATION (stable sur les rejeux). */
@Schema({ _id: false })
export class SupportRequestContext {
  @Prop({ type: String, required: true }) userName: string;
  @Prop({ type: String, required: true }) userEmail: string;
  @Prop({ type: String, required: true }) organizationName: string;
  @Prop({ type: String, default: null }) organizationSlug: string | null;
  @Prop({ type: String, required: true }) role: string;
  @Prop({ type: [String], default: [] }) permissions: string[];
}
const SupportRequestContextSchema = SchemaFactory.createForClass(
  SupportRequestContext,
);

/**
 * 1-16C.1 — Registre MINIMAL anti-doublon d'une demande d'assistance.
 *
 * Justification : la clé d'idempotence Resend expire après 24 h et ne dit
 * rien d'un envoi dont le résultat est inconnu ; ce registre garde l'état
 * de chaque intention (UUID client = `_id`, unicité par l'index natif) et le
 * contexte/date initiaux, pour qu'un rejeu produise exactement le même
 * message. Le SUJET et le MESSAGE ne sont PAS conservés : seule leur
 * empreinte SHA-256 permet de vérifier qu'un rejeu porte le même contenu.
 * Purge : index TTL (30 jours) créé par migration explicite.
 */
@Schema({
  collection: SUPPORT_REQUESTS_COLLECTION,
  autoIndex: false,
  versionKey: false,
})
export class SupportRequest {
  /** UUID v4 de l'intention, généré une fois par le client. */
  @Prop({ type: String, required: true })
  _id: string;

  @Prop({ type: String, required: true })
  reference: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    required: true,
  })
  organizationId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  membershipId: Types.ObjectId;

  @Prop({ type: String, required: true })
  category: string;

  /** SHA-256 de (catégorie, sujet, message, page, version) normalisés. */
  @Prop({ type: String, required: true })
  fingerprint: string;

  @Prop({ type: String, default: null })
  page: string | null;

  @Prop({ type: String, default: null })
  appVersion: string | null;

  @Prop({ type: SupportRequestContextSchema, required: true })
  context: SupportRequestContext;

  @Prop({
    type: String,
    enum: SupportRequestStatus,
    default: SupportRequestStatus.PENDING,
  })
  status: SupportRequestStatus;

  @Prop({ type: Number, default: 0 })
  attempts: number;

  /** Premier appel au transport : point de départ des 24 h de Resend. */
  @Prop({ type: Date, default: null })
  firstAttemptAt: Date | null;

  /** Premier résultat inconnu ; ensuite, la fenêtre de renvoi s'applique. */
  @Prop({ type: Date, default: null })
  uncertainAt: Date | null;

  @Prop({ type: Date, default: null })
  lockedUntil: Date | null;

  @Prop({ type: Date, default: null })
  sentAt: Date | null;

  /** Date serveur de la demande (horloge injectable), jamais client. */
  @Prop({ type: Date, required: true })
  createdAt: Date;
}

export type SupportRequestDocument = HydratedDocument<SupportRequest>;
export const SupportRequestSchema =
  SchemaFactory.createForClass(SupportRequest);
