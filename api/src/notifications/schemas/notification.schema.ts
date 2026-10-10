import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { PushCategory } from '../../push/schemas/push-category';
import { SubscriptionPeriodKind } from '../../subscriptions/subscription-terms';
import { MemberActivityAction, MemberActivityEntity } from '../member-activity';

export type NotificationDocument = HydratedDocument<AppNotification>;

export const NOTIFICATIONS_COLLECTION = 'notifications';

/**
 * 1-16A.1 — Notification LOGIQUE du centre : UN utilisateur dans UNE
 * organisation, pour UN événement (`eventKey`). L'état lu / non lu est donc
 * partagé par tous ses appareils. Distincte des livraisons push
 * (`push_deliveries`, une par appareil) : elle existe même si le push est
 * désactivé, refusé ou sans appareil.
 *
 * Aucun contenu métier n'est stocké : catégorie et références seules ; le
 * détail est relu à la consultation avec les droits ACTUELS.
 * 1-19A — exception limitée aux catégories `member-*` : nom de l'auteur et
 * nom des cibles FIGÉS (une cible supprimée définitivement, ou une
 * invitation supprimée après acceptation, reste compréhensible sans lien
 * cassé). Une activité regroupe les actions d'une même fenêtre
 * (`activityEventIds` : une action n'est jamais comptée deux fois).
 *
 * `expiresAt` : nul tant que non lue ; fixé à la première lecture
 * (`readAt` + rétention de la catégorie). Index TTL sur `expiresAt` pour le
 * nettoyage ; les lectures excluent déjà les notifications expirées.
 */
@Schema({
  collection: NOTIFICATIONS_COLLECTION,
  timestamps: true,
  autoIndex: false,
})
export class AppNotification {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    required: true,
  })
  organizationId: Types.ObjectId;

  @Prop({ type: String, enum: PushCategory, required: true })
  category: PushCategory;

  /** Événement d'origine (`push_jobs.eventKey`). */
  @Prop({ type: String, required: true, maxlength: 200 })
  eventKey: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  productId: Types.ObjectId | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  saleId: Types.ObjectId | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  paymentId: Types.ObjectId | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  reportId: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  coverageEndsAt: Date | null;

  @Prop({
    type: String,
    enum: [...Object.values(SubscriptionPeriodKind), null],
    default: null,
  })
  periodKind: SubscriptionPeriodKind | null;

  /** 1-19A : auteur (`member-*`). */
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  actorId: Types.ObjectId | null;

  /** 1-19A : nom de l'auteur figé à la répartition. */
  @Prop({ type: String, default: null, maxlength: 100 })
  actorName: string | null;

  /**
   * 1-19A : regroupement d'activité (`member-activity`). Champs à plat : un
   * même `updateOne` peut créer (`$setOnInsert`), compter (`$inc`) et
   * ajouter une cible (`$addToSet`) sans conflit de chemins.
   */
  @Prop({ type: String, enum: MemberActivityEntity, default: undefined })
  activityEntity?: MemberActivityEntity;

  @Prop({ type: String, enum: MemberActivityAction, default: undefined })
  activityAction?: MemberActivityAction;

  @Prop({ type: Number, default: undefined })
  activityCount?: number;

  @Prop({
    type: [
      {
        _id: false,
        id: { type: String, default: null },
        name: { type: String, default: null, maxlength: 120 },
      },
    ],
    default: undefined,
  })
  activityTargets?: Array<{ id: string | null; name: string | null }>;

  /** 1-19A : actions déjà comptées dans ce regroupement (jamais exposé). */
  @Prop({ type: [MongooseSchema.Types.ObjectId], default: undefined })
  activityEventIds?: Types.ObjectId[];

  /** Heure de l'événement (horloge serveur). */
  @Prop({ type: Date, required: true })
  eventAt: Date;

  @Prop({ type: Date, default: null })
  readAt: Date | null;

  @Prop({ type: Date, default: null })
  expiresAt: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export const AppNotificationSchema =
  SchemaFactory.createForClass(AppNotification);
