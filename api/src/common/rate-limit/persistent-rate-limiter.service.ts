import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { createHmac } from 'crypto';
import type { FixedWindowPolicy } from './anti-abuse-config';

/**
 * 1-18C — Compteurs à fenêtre FIXE dans MongoDB (`rate_limit_buckets`) :
 * partagés entre instances, conservés au redémarrage, sans service
 * supplémentaire (base déjà utilisée par l'API).
 *
 * - Une réservation est UNE mise à jour atomique (`findOneAndUpdate`
 *   + pipeline, `upsert`) : deux demandes concurrentes ne dépassent jamais
 *   le plafond.
 * - Clé : `scope:` + HMAC-SHA256(secret applicatif, scope + sujet). Ni
 *   adresse, ni mot de passe, ni jeton en clair dans la base ou les
 *   journaux ; le secret empêche de retrouver une adresse par dictionnaire.
 *   Changer `JWT_SECRET` remet les compteurs à zéro (sans risque).
 * - `expiresAt` = fin de la fenêtre : index TTL (migration
 *   `create-rate-limit-indexes`) ; sans lui, une fenêtre échue est
 *   simplement réinitialisée à la demande suivante.
 */
export const RATE_LIMIT_BUCKETS_COLLECTION = 'rate_limit_buckets';

const DUPLICATE_KEY = 11000;

interface Bucket {
  _id: string;
  scope: string;
  count: number;
  windowStartedAt: Date;
  expiresAt: Date;
}

export interface RateLimitReservation {
  /** Faux : plafond atteint, l'action doit être refusée. */
  allowed: boolean;
  /** Secondes avant la fin de la fenêtre (au moins 1). */
  retryAfterSeconds: number;
  /** Annule CETTE réservation (même fenêtre seulement, jamais sous 0). */
  release(): Promise<void>;
}

@Injectable()
export class PersistentRateLimiter {
  private readonly secret: string;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    config: ConfigService,
  ) {
    this.secret = config.getOrThrow<string>('JWT_SECRET');
  }

  /** Clé opaque d'un sujet (jamais réversible sans le secret). */
  keyFor(scope: string, subject: string): string {
    const digest = createHmac('sha256', this.secret)
      .update(`rate-limit\u0000${scope}\u0000${subject}`)
      .digest('hex');
    return `${scope}:${digest}`;
  }

  async consume(
    policy: FixedWindowPolicy,
    subject: string,
    now: Date = new Date(),
  ): Promise<RateLimitReservation> {
    const key = this.keyFor(policy.scope, subject);
    let bucket: Bucket | null = null;
    for (let attempt = 0; attempt < 2 && !bucket; attempt++) {
      try {
        bucket = await this.increment(key, policy, now);
      } catch (error) {
        // Deux premières réservations simultanées : une seule insertion
        // réussit ; l'autre est rejouée comme une mise à jour.
        if ((error as { code?: unknown }).code !== DUPLICATE_KEY) throw error;
      }
    }
    if (!bucket) throw new Error('Réservation de limitation impossible');
    const windowEnd = bucket.windowStartedAt.getTime() + policy.windowMs;
    const windowStartedAt = bucket.windowStartedAt;
    return {
      allowed: bucket.count <= policy.limit,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((windowEnd - now.getTime()) / 1000),
      ),
      release: async () => {
        await this.buckets()
          .updateOne(
            { _id: key, windowStartedAt, count: { $gt: 0 } },
            { $inc: { count: -1 } },
          )
          .catch(() => undefined);
      },
    };
  }

  /**
   * Ferme la fenêtre d'UN sujet (1-18C : seulement après un mot de passe
   * correct présenté avec un défi réussi ; jamais sur un simple défi).
   */
  async reset(scope: string, subject: string): Promise<void> {
    await this.buckets().deleteOne({ _id: this.keyFor(scope, subject) });
  }

  private buckets() {
    const db = this.connection.db;
    if (!db) throw new Error('connexion MongoDB non prête');
    return db.collection<Bucket>(RATE_LIMIT_BUCKETS_COLLECTION);
  }

  private async increment(
    key: string,
    policy: FixedWindowPolicy,
    now: Date,
  ): Promise<Bucket | null> {
    const staleBefore = new Date(now.getTime() - policy.windowMs);
    // Nouvelle fenêtre si aucune n'existe ou si la précédente est échue.
    const fresh = {
      $or: [
        { $eq: [{ $type: '$windowStartedAt' }, 'missing'] },
        { $lte: ['$windowStartedAt', staleBefore] },
      ],
    };
    return this.buckets().findOneAndUpdate(
      { _id: key },
      [
        {
          $set: {
            scope: policy.scope,
            count: { $cond: [fresh, 1, { $add: ['$count', 1] }] },
            windowStartedAt: { $cond: [fresh, now, '$windowStartedAt'] },
          },
        },
        {
          $set: {
            expiresAt: { $add: ['$windowStartedAt', policy.windowMs] },
          },
        },
      ],
      { upsert: true, returnDocument: 'after' },
    );
  }
}
