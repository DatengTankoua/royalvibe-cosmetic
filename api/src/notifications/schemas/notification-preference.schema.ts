import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import type { PushPreferences } from '../../push/schemas/push-category';

export type NotificationPreferenceDocument =
  HydratedDocument<NotificationPreference>;

export const NOTIFICATION_PREFERENCES_COLLECTION = 'notification_preferences';

/**
 * 1-16A.1 — Préférences du CENTRE par catégorie, pour un utilisateur dans une
 * organisation (tous appareils). Absent = toutes actives. Distinctes du
 * consentement push, propre à chaque appareil (`push_subscriptions`).
 * Une catégorie désactivée n'est plus créée et ses notifications existantes
 * sont masquées.
 */
@Schema({
  collection: NOTIFICATION_PREFERENCES_COLLECTION,
  timestamps: true,
  autoIndex: false,
})
export class NotificationPreference {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    required: true,
  })
  organizationId: Types.ObjectId;

  @Prop({
    type: {
      stockDepleted: { type: Boolean, required: true },
      stockLow: { type: Boolean, required: true },
      saleCreated: { type: Boolean, required: true },
      subscriptionEnding: { type: Boolean, required: true },
      paymentSucceeded: { type: Boolean, required: true },
      monthlyReport: { type: Boolean, required: true },
    },
    _id: false,
    required: true,
  })
  categories: PushPreferences;
}

export const NotificationPreferenceSchema = SchemaFactory.createForClass(
  NotificationPreference,
);
