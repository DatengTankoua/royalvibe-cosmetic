import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import {
  SUBSCRIPTION_GRANTOR_MAX_LENGTH,
  SUBSCRIPTION_REFERENCE_MAX_LENGTH,
  SubscriptionPeriodKind,
  SubscriptionSource,
  SubscriptionTerm,
} from '../subscription-terms';

export type SubscriptionPeriodDocument = HydratedDocument<SubscriptionPeriod>;

export const SUBSCRIPTION_PERIODS_COLLECTION = 'subscription_periods';

/**
 * 1-14B — Registre des périodes d'abonnement d'une organisation (jamais d'un
 * utilisateur). Ajout seul : une attribution = un document ; aucune période
 * n'est modifiée ni supprimée. Source de vérité de l'état commercial,
 * indépendante de `Organization.status` (suspension administrative).
 *
 * `sequence` : rang dans la chaîne de l'organisation (1 = première période).
 * L'index unique `{ organizationId, sequence }` interdit deux successeurs
 * d'une même période (aucune branche concurrente).
 *
 * `autoIndex: false` : les 3 index uniques ne sont JAMAIS créés au
 * démarrage. Migration dédiée
 * (`migrations/create-subscription-period-indexes.ts`), vérification
 * fail-fast en production (`SubscriptionPeriodIndexCheck`).
 */
@Schema({
  collection: SUBSCRIPTION_PERIODS_COLLECTION,
  timestamps: { createdAt: true, updatedAt: false },
  autoIndex: false,
})
export class SubscriptionPeriod {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Organization',
    required: true,
  })
  organizationId: Types.ObjectId;

  @Prop({
    type: Number,
    required: true,
    min: 1,
    validate: {
      validator: (value: unknown) => Number.isInteger(value),
      message: 'sequence doit être un entier.',
    },
  })
  sequence: number;

  @Prop({ type: String, enum: SubscriptionPeriodKind, required: true })
  kind: SubscriptionPeriodKind;

  /** Requis pour un abonnement, `null` pour l'essai. */
  @Prop({
    type: String,
    enum: [...Object.values(SubscriptionTerm), null],
    default: null,
    validate: {
      validator: function (
        this: SubscriptionPeriod,
        value: SubscriptionTerm | null,
      ) {
        return this.kind === SubscriptionPeriodKind.TRIAL
          ? value === null
          : value !== null;
      },
      message: "term requis pour un abonnement, interdit pour l'essai.",
    },
  })
  term: SubscriptionTerm | null;

  @Prop({ type: Date, required: true })
  startsAt: Date;

  /** Exclu : la période couvre `[startsAt, endsAt)`. */
  @Prop({
    type: Date,
    required: true,
    validate: {
      validator: function (this: SubscriptionPeriod, value: Date) {
        return (
          value instanceof Date &&
          this.startsAt instanceof Date &&
          value.getTime() > this.startsAt.getTime()
        );
      },
      message: 'endsAt doit être postérieur à startsAt.',
    },
  })
  endsAt: Date;

  @Prop({
    type: String,
    enum: SubscriptionSource,
    required: true,
    validate: {
      validator: function (this: SubscriptionPeriod, value: unknown) {
        return (
          (this.kind === SubscriptionPeriodKind.TRIAL) ===
          (value === SubscriptionSource.TRIAL)
        );
      },
      message: 'source incohérente avec kind.',
    },
  })
  source: SubscriptionSource;

  /** Clé d'idempotence (unique par `source`). */
  @Prop({
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: SUBSCRIPTION_REFERENCE_MAX_LENGTH,
  })
  sourceReference: string;

  /** Opérateur (CLI) ou `system` ; interne, jamais exposé. */
  @Prop({
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: SUBSCRIPTION_GRANTOR_MAX_LENGTH,
  })
  grantedBy: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'SubscriptionPeriod',
    default: null,
  })
  previousPeriodId: Types.ObjectId | null;

  createdAt?: Date;
}

export const SubscriptionPeriodSchema =
  SchemaFactory.createForClass(SubscriptionPeriod);
