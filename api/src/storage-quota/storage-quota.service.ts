import {
  Injectable,
  Logger,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import {
  ORGANIZATIONS_PREFIX,
  S3Service,
  type ListedObject,
  type StorageCleanup,
  type StoredObjectRef,
} from '../s3/s3.service';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import {
  Organization,
  OrganizationDocument,
} from '../organizations/schemas/organization.schema';
import {
  StoredObject,
  StoredObjectDocument,
  StoredObjectState,
  storedObjectId,
} from './schemas/stored-object.schema';
import {
  StorageUsage,
  StorageUsageDocument,
} from './schemas/storage-usage.schema';
import { prefixForKind, type StoredObjectKind } from './storage-prefixes';
import {
  parseStorageQuotaConfig,
  type StorageQuotaConfig,
} from './storage-quota.config';

// Session transactionnelle Mongoose (même dérivation que les produits).
type MongooseSession = Awaited<ReturnType<Connection['startSession']>>;

/**
 * Fichier envoyé et comptabilisé (`uploaded`), pas encore rattaché : à
 * passer à `attach` DANS la transaction qui écrit sa référence, ou à
 * `discard` si cette écriture échoue.
 */
export interface StagedObject extends StoredObjectRef {
  storage: string;
  id: string;
  organizationId: string;
  kind: StoredObjectKind;
  bytes: number;
}

/** Vue d'occupation renvoyée aux membres autorisés (jamais de clé). */
export interface StorageUsageView {
  limitBytes: number;
  usedBytes: number;
  storedObjects: number;
  reservedBytes: number;
  pendingUploads: number;
  availableBytes: number;
  enforced: boolean;
}

export type RecoveryOutcome = 'released' | 'attached' | 'retry' | 'skipped';

export interface RecoveryInspection {
  due: {
    count: number;
    bytes: number;
    byState: Partial<
      Record<StoredObjectState, { count: number; bytes: number }>
    >;
  };
  notYetDue: { count: number; bytes: number; nextLeaseUntil: Date | null };
  /** Plus grand nombre de tentatives échouées (suppression qui échoue). */
  maxAttempts: number;
}

export interface StorageRecoveryReport {
  examined: number;
  released: number;
  attached: number;
  retry: number;
  skipped: number;
}

/** Catégories de l'initialisation (aucune clé ni URL n'est rapportée). */
export type InitializationCategory =
  | 'already_tracked'
  | 'to_count'
  | 'counted'
  | 'missing'
  | 'unknown_size'
  | 'other_storage'
  | 'bad_prefix'
  | 'no_organization'
  | 'reference_changed';

export interface OrganizationInitializationReport {
  organizationId: string;
  counts: Partial<Record<InitializationCategory, number>>;
  bytes: Partial<Record<'already_tracked' | 'to_count' | 'counted', number>>;
  projectedUsedBytes: number;
  reservedBytes: number;
  limitBytes: number;
  overQuota: boolean;
}

export interface InitializationReport {
  apply: boolean;
  storage: string | null;
  mode: StorageQuotaConfig['mode'];
  organizations: OrganizationInitializationReport[];
  totals: Partial<Record<InitializationCategory, number>>;
  complete: boolean;
}

/** Catégories de l'inventaire du stockage (aucune clé rapportée). */
export type InventoryCategory =
  'tracked' | 'untracked_referenced' | 'untracked_unreferenced' | 'foreign_key';

export interface InventoryReport {
  apply: boolean;
  storage: string | null;
  organizations: {
    organizationId: string;
    counts: Partial<Record<InventoryCategory, number>>;
    bytes: Partial<Record<InventoryCategory, number>>;
  }[];
  totals: Partial<Record<InventoryCategory, number>>;
  /** Fichiers non référencés supprimés ET libérés pendant cette passe. */
  deleted: number;
  /** Fichiers non référencés comptés, suppression après délai de grâce. */
  pendingDeletion: number;
}

export interface OrphanReport {
  apply: boolean;
  examined: number;
  orphaned: number;
  orphanedBytes: number;
  released: number;
  reattached: number;
  retry: number;
  organizations: { organizationId: string; orphaned: number; bytes: number }[];
}

/** Clé d'un fichier d'organisation : préfixe EXACT, un seul segment final. */
const ORGANIZATION_OBJECT_KEY =
  /^organizations\/([0-9a-f]{24})\/(products|branding)\/[^/]+$/;

export const STORAGE_QUOTA_EXCEEDED = 'STORAGE_QUOTA_EXCEEDED';
export const STORAGE_UPLOAD_INTERRUPTED = 'STORAGE_UPLOAD_INTERRUPTED';

/** Délai maximal entre deux tentatives de reprise d'une même entrée. */
const MAX_RETRY_DELAY_MS = 6 * 3600 * 1000;

function zeroUsage() {
  return {
    storedBytes: 0,
    storedObjects: 0,
    reservedBytes: 0,
    reservedObjects: 0,
  };
}

/**
 * 1-17B — Quotas de stockage par organisation.
 *
 * Registre `storage_objects` (un fichier = une entrée) + compteur
 * `storage_usages` (un document par organisation), toujours modifiés dans
 * la MÊME transaction MongoDB courte. Aucune transaction n'est ouverte
 * pendant un appel au stockage.
 *
 * Cycle d'un envoi :
 * 1. `reserve` — transaction : incrément CONDITIONNEL du compteur
 *    (`stockés + réservés + taille ≤ quota` en mode `enforce`) et entrée
 *    `reserved` (clé générée côté serveur AVANT l'envoi).
 * 2. Envoi au stockage (hors transaction), annulé au tiers de la durée de
 *    réservation.
 * 3. `markUploaded` — transaction : `reserved → uploaded`, octets passés de
 *    « réservés » à « stockés ».
 * 4. `attach` — dans la transaction de l'appelant qui écrit la référence
 *    (produit, logo) : `uploaded → attached`. L'ancienne référence passe
 *    `attached → deleting` dans la même transaction (`detach`).
 * 5. Après le commit : suppression de l'ancien fichier, puis libération
 *    SEULEMENT si la suppression est confirmée (`deleteDetached`).
 *
 * Échecs : un envoi échoué est supprimé (suppression idempotente = absence
 * confirmée) puis libéré ; sinon il reste réservé. Une entrée dont
 * l'échéance est dépassée est reprise par `recover`, qui revérifie la
 * référence en base, supprime le fichier puis libère — jamais sur la seule
 * foi de l'échéance. Toute transition est conditionnelle à l'état attendu :
 * deux traitements concurrents ne comptent ni ne libèrent jamais deux fois.
 */
@Injectable()
export class StorageQuotaService {
  private readonly logger = new Logger('StorageQuota');
  readonly config: StorageQuotaConfig;

  constructor(
    @InjectModel(StoredObject.name)
    private readonly objects: Model<StoredObjectDocument>,
    @InjectModel(StorageUsage.name)
    private readonly usages: Model<StorageUsageDocument>,
    @InjectModel(Product.name)
    private readonly products: Model<ProductDocument>,
    @InjectModel(Organization.name)
    private readonly organizations: Model<OrganizationDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly s3: S3Service,
    configService: ConfigService,
  ) {
    this.config = parseStorageQuotaConfig({
      STORAGE_QUOTA_BYTES: configService.get<string>('STORAGE_QUOTA_BYTES'),
      STORAGE_QUOTA_MODE: configService.get<string>('STORAGE_QUOTA_MODE'),
      STORAGE_RESERVATION_TTL_SECONDS: configService.get<string>(
        'STORAGE_RESERVATION_TTL_SECONDS',
      ),
      STORAGE_RECOVERY_INTERVAL_SECONDS: configService.get<string>(
        'STORAGE_RECOVERY_INTERVAL_SECONDS',
      ),
      STORAGE_INVENTORY_INTERVAL_SECONDS: configService.get<string>(
        'STORAGE_INVENTORY_INTERVAL_SECONDS',
      ),
    });
  }

  /** Horloge (substituable en test). */
  protected now(): number {
    return Date.now();
  }

  private leaseFromNow(): Date {
    return new Date(this.now() + this.config.reservationTtlSeconds * 1000);
  }

  private async inTransaction<T>(
    work: (session: MongooseSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.connection.startSession();
    try {
      let result: T | undefined;
      await session.withTransaction(async () => {
        result = await work(session);
      });
      return result as T;
    } finally {
      await session.endSession();
    }
  }

  /** Compteur présent (création idempotente, HORS transaction). */
  private async ensureUsage(organizationOid: Types.ObjectId): Promise<void> {
    try {
      await this.usages
        .updateOne(
          { _id: organizationOid },
          { $setOnInsert: zeroUsage() },
          { upsert: true },
        )
        .exec();
    } catch (err) {
      // Deux créations simultanées : l'une échoue sur `_id`, le document
      // existe donc — sans effet.
      if ((err as { code?: unknown })?.code !== 11000) throw err;
    }
  }

  // ─── Envoi ────────────────────────────────────────────────────────────

  /**
   * Réserve, envoie et comptabilise un fichier DÉJÀ validé. La taille
   * comptée est celle des octets envoyés (`body.length`, côté serveur).
   * Lève `STORAGE_QUOTA_EXCEEDED` (413) sans rien envoyer si le quota serait
   * dépassé (mode `enforce`).
   */
  async store(input: {
    organizationId: string;
    kind: StoredObjectKind;
    body: Buffer;
    image: { extension: string; contentType: string };
  }): Promise<StagedObject> {
    const storage = this.s3.storage;
    if (!storage) throw new Error('Stockage non configuré');
    const prefix = prefixForKind(input.kind, input.organizationId);
    const key = this.s3.newObjectKey(prefix, input.image.extension);
    const staged: StagedObject = {
      id: storedObjectId(storage, key),
      key,
      storage,
      organizationId: input.organizationId,
      kind: input.kind,
      bytes: input.body.length,
    };
    await this.reserveOrReject(staged);

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      (this.config.reservationTtlSeconds * 1000) / 3,
    );
    timer.unref?.();
    try {
      const ref = await this.s3.uploadValidatedImage(
        input.body,
        prefix,
        input.image,
        { key, abortSignal: controller.signal },
      );
      if (ref.key !== key || ref.storage !== storage) {
        throw new Error('Référence de stockage inattendue');
      }
    } catch (err) {
      await this.abandonReservation(staged);
      throw err;
    } finally {
      clearTimeout(timer);
    }

    // Échec MongoDB ici : l'entrée reste `reserved`, reprise après échéance.
    const marked = await this.markUploaded(staged);
    if (!marked) {
      // Échéance dépassée et entrée déjà reprise : le fichier n'est rattaché
      // à rien, sa suppression est (aussi) assurée par la reprise.
      await this.s3.deleteStoredObject(staged, prefix).catch(() => undefined);
      throw this.interrupted();
    }
    return staged;
  }

  private interrupted(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: STORAGE_UPLOAD_INTERRUPTED,
      message: "L'envoi du fichier a été interrompu. Réessayez.",
    });
  }

  private async reserveOrReject(staged: StagedObject): Promise<void> {
    if (await this.reserve(staged)) return;
    // Refus : réservations interrompues de CETTE organisation reprises
    // (si leur échéance est passée), puis une seule nouvelle tentative.
    const report = await this.recover({
      organizationId: staged.organizationId,
      limit: 50,
    });
    if (report.released > 0 && (await this.reserve(staged))) return;
    throw await this.quotaExceeded(staged.organizationId, staged.bytes);
  }

  /** `false` si le quota serait dépassé (aucune écriture). */
  private async reserve(staged: StagedObject): Promise<boolean> {
    const organizationOid = new Types.ObjectId(staged.organizationId);
    await this.ensureUsage(organizationOid);
    const enforce = this.config.mode === 'enforce';
    return this.inTransaction(async (session) => {
      const filter: Record<string, unknown> = { _id: organizationOid };
      if (enforce) {
        filter.$expr = {
          $lte: [
            {
              $add: [
                { $ifNull: ['$storedBytes', 0] },
                { $ifNull: ['$reservedBytes', 0] },
                staged.bytes,
              ],
            },
            this.config.quotaBytes,
          ],
        };
      }
      const updated = await this.usages
        .updateOne(
          filter,
          { $inc: { reservedBytes: staged.bytes, reservedObjects: 1 } },
          { session },
        )
        .exec();
      if (updated.matchedCount === 0) return false;
      await this.objects.create(
        [
          {
            _id: staged.id,
            organizationId: organizationOid,
            storage: staged.storage,
            key: staged.key,
            kind: staged.kind,
            bytes: staged.bytes,
            state: 'reserved',
            leaseUntil: this.leaseFromNow(),
            attempts: 0,
            source: 'upload',
          },
        ],
        { session },
      );
      return true;
    });
  }

  private async quotaExceeded(
    organizationId: string,
    requestedBytes: number,
  ): Promise<PayloadTooLargeException> {
    const usage = await this.usage(organizationId).catch(() => null);
    return new PayloadTooLargeException({
      code: STORAGE_QUOTA_EXCEEDED,
      message:
        "Espace de stockage insuffisant : cet envoi dépasserait le quota de l'organisation.",
      limitBytes: this.config.quotaBytes,
      usedBytes: usage?.usedBytes,
      reservedBytes: usage?.reservedBytes,
      requestedBytes,
    });
  }

  /** `reserved → uploaded` ; `false` si l'entrée n'est plus réservée. */
  private async markUploaded(staged: StagedObject): Promise<boolean> {
    return this.inTransaction(async (session) => {
      const updated = await this.objects
        .updateOne(
          { _id: staged.id, state: 'reserved' },
          { $set: { state: 'uploaded', leaseUntil: this.leaseFromNow() } },
          { session },
        )
        .exec();
      if (updated.modifiedCount === 0) return false;
      await this.usages
        .updateOne(
          { _id: new Types.ObjectId(staged.organizationId) },
          {
            $inc: {
              reservedBytes: -staged.bytes,
              reservedObjects: -1,
              storedBytes: staged.bytes,
              storedObjects: 1,
            },
          },
          { session },
        )
        .exec();
      return true;
    });
  }

  /**
   * Envoi échoué ou annulé : ni l'erreur ni l'annulation côté SDK ne
   * prouvent que la requête n'aboutira pas (corps déjà transmis, requête
   * encore en vol). La réservation reste donc COMPTÉE avec une nouvelle
   * échéance ; la suppression est tentée dès maintenant (objet déjà
   * arrivé) et la reprise libère après l'échéance, sur suppression
   * confirmée. Un objet arrivé plus tard encore est retrouvé par
   * l'inventaire (`reconcileInventory`). N'échoue jamais.
   */
  private async abandonReservation(staged: StagedObject): Promise<void> {
    try {
      await this.objects
        .updateOne(
          { _id: staged.id, state: 'reserved' },
          { $set: { leaseUntil: this.leaseFromNow() } },
        )
        .exec();
    } catch {
      this.logger.warn('Réservation conservée pour reprise (envoi échoué).');
    }
    await this.s3
      .deleteStoredObject(
        staged,
        prefixForKind(staged.kind, staged.organizationId),
      )
      .catch(() => undefined);
  }

  // ─── Rattachement (dans la transaction de l'appelant) ────────────────

  /** `uploaded → attached`, dans la transaction qui écrit la référence. */
  async attach(staged: StagedObject, session: MongooseSession): Promise<void> {
    const updated = await this.objects
      .updateOne(
        { _id: staged.id, state: 'uploaded' },
        { $set: { state: 'attached', leaseUntil: null } },
        { session },
      )
      .exec();
    if (updated.matchedCount === 0) throw this.interrupted();
  }

  /**
   * `attached → deleting` pour une référence qui disparaît (remplacement,
   * suppression du logo, purge), dans la transaction de l'appelant. Sans
   * entrée (fichier non initialisé, autre stockage) : aucun effet.
   */
  async detach(
    organizationId: string,
    ref: StoredObjectRef | null,
    session: MongooseSession,
  ): Promise<void> {
    if (!ref || !ref.storage || ref.storage !== this.s3.storage) return;
    await this.objects
      .updateOne(
        {
          _id: storedObjectId(ref.storage, ref.key),
          organizationId: new Types.ObjectId(organizationId),
          state: 'attached',
        },
        { $set: { state: 'deleting', leaseUntil: this.leaseFromNow() } },
        { session },
      )
      .exec();
  }

  /**
   * APRÈS le commit : suppression du fichier détaché ; libération seulement
   * si elle est confirmée. Échec → entrée `deleting` conservée et comptée,
   * reprise ensuite.
   */
  async deleteDetached(
    organizationId: string,
    ref: StoredObjectRef | null,
    allowedPrefix: string,
  ): Promise<StorageCleanup> {
    const cleanup = await this.s3.deleteStoredObject(ref, allowedPrefix);
    if (cleanup === 'deleted' && ref?.storage) {
      try {
        await this.release(storedObjectId(ref.storage, ref.key), 'deleting');
      } catch {
        this.logger.warn(
          `Libération différée (organisation ${organizationId}) : reprise.`,
        );
      }
    }
    return cleanup;
  }

  /**
   * Écriture de la référence échouée après l'envoi : fichier supprimé et
   * libéré s'il n'est référencé par AUCUN document (une écriture validée
   * malgré l'erreur le rattache) ; sinon conservé pour la reprise.
   */
  async discard(staged: StagedObject): Promise<void> {
    try {
      const decision = await this.inTransaction(async (session) => {
        if (await this.isReferenced(staged, session)) {
          await this.objects
            .updateOne(
              { _id: staged.id, state: 'uploaded' },
              { $set: { state: 'attached', leaseUntil: null } },
              { session },
            )
            .exec();
          return 'kept';
        }
        const updated = await this.objects
          .updateOne(
            { _id: staged.id, state: 'uploaded' },
            { $set: { state: 'deleting', leaseUntil: this.leaseFromNow() } },
            { session },
          )
          .exec();
        return updated.modifiedCount > 0 ? 'delete' : 'skip';
      });
      if (decision !== 'delete') return;
      const cleanup = await this.deleteDetached(
        staged.organizationId,
        staged,
        prefixForKind(staged.kind, staged.organizationId),
      );
      if (cleanup !== 'deleted') {
        this.logger.warn(`Fichier non référencé conservé (${cleanup}).`);
      }
    } catch {
      this.logger.warn('Fichier non référencé conservé pour reprise.');
    }
  }

  /** Suppression conditionnelle de l'entrée + décrément, en transaction. */
  private async release(
    id: string,
    expected: StoredObjectState,
  ): Promise<boolean> {
    return this.inTransaction(async (session) => {
      const removed = await this.objects
        .findOneAndDelete({ _id: id, state: expected }, { session })
        .exec();
      if (!removed) return false;
      const inc =
        expected === 'reserved'
          ? { reservedBytes: -removed.bytes, reservedObjects: -1 }
          : { storedBytes: -removed.bytes, storedObjects: -1 };
      await this.usages
        .updateOne({ _id: removed.organizationId }, { $inc: inc }, { session })
        .exec();
      return true;
    });
  }

  private async isReferenced(
    entry: { kind: StoredObjectKind; organizationId: string; key: string },
    session?: MongooseSession,
  ): Promise<boolean> {
    const organizationOid = new Types.ObjectId(entry.organizationId);
    const query =
      entry.kind === 'logo'
        ? this.organizations.exists({
            _id: organizationOid,
            logoKey: entry.key,
          })
        : this.products.exists({
            organizationId: organizationOid,
            imageKey: entry.key,
          });
    if (session) query.session(session);
    return (await query.exec()) !== null;
  }

  /**
   * Référence relue ET verrouillée dans la transaction : écriture sur le
   * document qui référence le fichier (`__v`, sans horodatage), pour qu'un
   * détachement concurrent (remplacement, purge, retrait du logo), qui
   * écrit ce même document, entre en conflit d'écriture et soit rejoué
   * APRÈS ce commit — il trouve alors l'entrée et la détache. `false` si le
   * fichier n'est plus référencé.
   */
  private async lockReference(
    entry: { kind: StoredObjectKind; organizationId: string; key: string },
    session: MongooseSession,
  ): Promise<boolean> {
    const organizationOid = new Types.ObjectId(entry.organizationId);
    const result =
      entry.kind === 'logo'
        ? await this.organizations
            .updateOne(
              { _id: organizationOid, logoKey: entry.key },
              { $inc: { __v: 1 } },
              { session, timestamps: false },
            )
            .exec()
        : await this.products
            .updateMany(
              { organizationId: organizationOid, imageKey: entry.key },
              { $inc: { __v: 1 } },
              { session, timestamps: false },
            )
            .exec();
    return result.matchedCount > 0;
  }

  // ─── Lecture ──────────────────────────────────────────────────────────

  async usage(organizationId: string): Promise<StorageUsageView> {
    const doc = await this.usages
      .findById(new Types.ObjectId(organizationId))
      .lean()
      .exec();
    const usedBytes = Math.max(0, doc?.storedBytes ?? 0);
    const reservedBytes = Math.max(0, doc?.reservedBytes ?? 0);
    return {
      limitBytes: this.config.quotaBytes,
      usedBytes,
      storedObjects: Math.max(0, doc?.storedObjects ?? 0),
      reservedBytes,
      pendingUploads: Math.max(0, doc?.reservedObjects ?? 0),
      availableBytes: Math.max(
        0,
        this.config.quotaBytes - usedBytes - reservedBytes,
      ),
      enforced: this.config.mode === 'enforce',
    };
  }

  // ─── Reprise ──────────────────────────────────────────────────────────

  /**
   * Reprise des entrées `reserved`, `uploaded` ou `deleting` dont
   * l'échéance est dépassée. Pour chacune, en transaction : référencée en
   * base → `attached` ; sinon → `deleting`. Puis, hors transaction,
   * suppression du fichier et libération SEULEMENT si elle est confirmée ;
   * échec → nouvelle échéance (délai croissant), comptabilisation conservée.
   */
  async recover(
    options: { organizationId?: string; limit?: number } = {},
  ): Promise<StorageRecoveryReport> {
    const filter: Record<string, unknown> = {
      state: { $in: ['reserved', 'uploaded', 'deleting'] },
      leaseUntil: { $lte: new Date(this.now()) },
    };
    if (options.organizationId) {
      filter.organizationId = new Types.ObjectId(options.organizationId);
    }
    const entries = await this.objects
      .find(filter)
      .sort({ leaseUntil: 1 })
      .limit(options.limit ?? 100)
      .lean()
      .exec();
    const report: StorageRecoveryReport = {
      examined: entries.length,
      released: 0,
      attached: 0,
      retry: 0,
      skipped: 0,
    };
    for (const entry of entries) {
      let outcome: RecoveryOutcome;
      try {
        outcome = await this.recoverEntry(entry);
      } catch {
        await this.postpone(entry).catch(() => undefined);
        outcome = 'retry';
      }
      report[outcome] += 1;
    }
    return report;
  }

  /**
   * État des lieux de la reprise, SANS écriture : entrées `reserved`,
   * `uploaded` ou `deleting` échues (traitées par la prochaine reprise) ou
   * non encore échues, par état, avec leurs octets et la prochaine échéance.
   */
  async inspectRecovery(
    options: { organizationId?: string } = {},
  ): Promise<RecoveryInspection> {
    const match: Record<string, unknown> = {
      state: { $in: ['reserved', 'uploaded', 'deleting'] },
    };
    if (options.organizationId) {
      match.organizationId = new Types.ObjectId(options.organizationId);
    }
    const now = new Date(this.now());
    const rows = await this.objects
      .aggregate<{
        _id: { state: StoredObjectState; due: boolean };
        count: number;
        bytes: number;
        next: Date | null;
        attempts: number;
      }>([
        { $match: match },
        {
          $group: {
            _id: {
              state: '$state',
              due: { $lte: [{ $ifNull: ['$leaseUntil', now] }, now] },
            },
            count: { $sum: 1 },
            bytes: { $sum: '$bytes' },
            next: { $min: '$leaseUntil' },
            attempts: { $max: '$attempts' },
          },
        },
      ])
      .exec();
    const report: RecoveryInspection = {
      due: { count: 0, bytes: 0, byState: {} },
      notYetDue: { count: 0, bytes: 0, nextLeaseUntil: null },
      maxAttempts: 0,
    };
    for (const row of rows) {
      report.maxAttempts = Math.max(report.maxAttempts, row.attempts ?? 0);
      if (row._id.due) {
        report.due.count += row.count;
        report.due.bytes += row.bytes;
        report.due.byState[row._id.state] = {
          count: row.count,
          bytes: row.bytes,
        };
      } else {
        report.notYetDue.count += row.count;
        report.notYetDue.bytes += row.bytes;
        if (
          row.next &&
          (!report.notYetDue.nextLeaseUntil ||
            row.next < report.notYetDue.nextLeaseUntil)
        ) {
          report.notYetDue.nextLeaseUntil = row.next;
        }
      }
    }
    return report;
  }

  private async recoverEntry(entry: StoredObject): Promise<RecoveryOutcome> {
    const organizationId = entry.organizationId.toString();
    const decision = await this.inTransaction(async (session) => {
      const current = await this.objects
        .findOne({ _id: entry._id, state: entry.state }, null, { session })
        .exec();
      if (!current) return 'skipped' as const;
      const fromReserved = current.state === 'reserved';
      const referenced = await this.isReferenced(
        { kind: current.kind, organizationId, key: current.key },
        session,
      );
      const next: StoredObjectState = referenced ? 'attached' : 'deleting';
      if (current.state !== next) {
        await this.objects
          .updateOne(
            { _id: current._id, state: current.state },
            {
              $set: {
                state: next,
                leaseUntil: referenced ? null : this.leaseFromNow(),
              },
            },
            { session },
          )
          .exec();
      }
      // Une réservation reprise désigne un fichier POSSIBLEMENT envoyé :
      // ses octets restent comptés, comme stockés, jusqu'à suppression.
      if (fromReserved) {
        await this.usages
          .updateOne(
            { _id: current.organizationId },
            {
              $inc: {
                reservedBytes: -current.bytes,
                reservedObjects: -1,
                storedBytes: current.bytes,
                storedObjects: 1,
              },
            },
            { session },
          )
          .exec();
      }
      return referenced ? ('attached' as const) : ('delete' as const);
    });
    if (decision !== 'delete') return decision;

    const cleanup = await this.s3.deleteStoredObject(
      { key: entry.key, storage: entry.storage },
      prefixForKind(entry.kind, organizationId),
    );
    if (cleanup !== 'deleted') {
      // `retained` (autre stockage) ou `failed` : jamais libéré à l'aveugle.
      await this.postpone(entry);
      return 'retry';
    }
    return (await this.release(entry._id, 'deleting')) ? 'released' : 'skipped';
  }

  private async postpone(entry: StoredObject): Promise<void> {
    const attempts = (entry.attempts ?? 0) + 1;
    const delay = Math.min(
      this.config.reservationTtlSeconds * 1000 * attempts,
      MAX_RETRY_DELAY_MS,
    );
    await this.objects
      .updateOne(
        { _id: entry._id, state: { $ne: 'attached' } },
        {
          $set: { leaseUntil: new Date(this.now() + delay) },
          $inc: { attempts: 1 },
        },
      )
      .exec();
  }

  // ─── Recalcul ─────────────────────────────────────────────────────────

  /**
   * Reconstruit le compteur d'une organisation depuis le registre, dans
   * une transaction (instantané cohérent ; une réservation concurrente
   * provoque un conflit rejoué). `apply: false` : comparaison seule.
   */
  async recompute(
    organizationId: string,
    apply: boolean,
  ): Promise<{
    organizationId: string;
    current: ReturnType<typeof zeroUsage>;
    expected: ReturnType<typeof zeroUsage>;
    consistent: boolean;
  }> {
    const organizationOid = new Types.ObjectId(organizationId);
    if (apply) await this.ensureUsage(organizationOid);
    return this.inTransaction(async (session) => {
      const rows = await this.objects
        .aggregate<{ _id: string; bytes: number; count: number }>([
          { $match: { organizationId: organizationOid } },
          {
            $group: {
              _id: '$state',
              bytes: { $sum: '$bytes' },
              count: { $sum: 1 },
            },
          },
        ])
        .session(session)
        .exec();
      const expected = zeroUsage();
      for (const row of rows) {
        if (row._id === 'reserved') {
          expected.reservedBytes += row.bytes;
          expected.reservedObjects += row.count;
        } else {
          expected.storedBytes += row.bytes;
          expected.storedObjects += row.count;
        }
      }
      const doc = await this.usages
        .findById(organizationOid, null, { session })
        .lean()
        .exec();
      const current = {
        storedBytes: doc?.storedBytes ?? 0,
        storedObjects: doc?.storedObjects ?? 0,
        reservedBytes: doc?.reservedBytes ?? 0,
        reservedObjects: doc?.reservedObjects ?? 0,
      };
      const consistent = (
        Object.keys(expected) as (keyof typeof expected)[]
      ).every((k) => expected[k] === current[k]);
      if (apply && !consistent) {
        await this.usages
          .updateOne({ _id: organizationOid }, { $set: expected }, { session })
          .exec();
      }
      return { organizationId, current, expected, consistent };
    });
  }

  /** Organisations ayant un compteur ou une entrée au registre. */
  async trackedOrganizationIds(): Promise<string[]> {
    const [fromUsage, fromObjects] = await Promise.all([
      this.usages.distinct('_id').exec(),
      this.objects.distinct('organizationId').exec(),
    ]);
    return [
      ...new Set(
        [...fromUsage, ...fromObjects].map((id) => String(id as unknown)),
      ),
    ].sort();
  }

  // ─── Initialisation des fichiers existants ────────────────────────────

  /**
   * Comptabilise les fichiers DÉJÀ référencés (photos, y compris en
   * corbeille, et logos) à partir de MongoDB et de la taille VÉRIFIÉE par
   * `HeadObject` (aucun téléchargement). Seuls les fichiers du stockage
   * courant, sous le préfixe EXACT de leur organisation, sont comptés.
   * Taille inconnue → non comptée, signalée (`unknown_size`), jamais 0 ;
   * fichier absent (404) → `missing`, non compté.
   *
   * `apply: false` : diagnostic SANS aucune écriture (MongoDB ni stockage).
   * `apply: true` : relançable — une entrée déjà présente n'est jamais
   * recomptée ; la référence est relue dans la transaction d'écriture.
   */
  async initializeExisting(options: {
    apply: boolean;
    organizationId?: string;
  }): Promise<InitializationReport> {
    const storage = this.s3.storage;
    const perOrg = new Map<string, OrganizationInitializationReport>();
    const totals: Partial<Record<InitializationCategory, number>> = {};
    const reportFor = (organizationId: string) => {
      let report = perOrg.get(organizationId);
      if (!report) {
        report = {
          organizationId,
          counts: {},
          bytes: {},
          projectedUsedBytes: 0,
          reservedBytes: 0,
          limitBytes: this.config.quotaBytes,
          overQuota: false,
        };
        perOrg.set(organizationId, report);
      }
      return report;
    };
    const note = (
      organizationId: string | null,
      category: InitializationCategory,
      bytes?: number,
    ) => {
      totals[category] = (totals[category] ?? 0) + 1;
      if (!organizationId) return;
      const report = reportFor(organizationId);
      report.counts[category] = (report.counts[category] ?? 0) + 1;
      if (
        bytes !== undefined &&
        (category === 'already_tracked' ||
          category === 'to_count' ||
          category === 'counted')
      ) {
        report.bytes[category] = (report.bytes[category] ?? 0) + bytes;
      }
    };

    const candidates: {
      organizationId: string | null;
      kind: StoredObjectKind;
      key: string;
      storage: string | null;
    }[] = [];
    const orgFilter = options.organizationId
      ? new Types.ObjectId(options.organizationId)
      : undefined;
    const productCursor = this.products
      .find(
        {
          imageKey: { $type: 'string' },
          ...(orgFilter ? { organizationId: orgFilter } : {}),
        },
        { organizationId: 1, imageKey: 1, imageStorage: 1 },
      )
      .lean()
      .cursor();
    for await (const p of productCursor) {
      candidates.push({
        organizationId: p.organizationId ? String(p.organizationId) : null,
        kind: 'product_image',
        key: p.imageKey as string,
        storage: p.imageStorage ?? null,
      });
    }
    const organizationCursor = this.organizations
      .find(
        {
          logoKey: { $type: 'string' },
          ...(orgFilter ? { _id: orgFilter } : {}),
        },
        { logoKey: 1, logoStorage: 1 },
      )
      .lean()
      .cursor();
    for await (const o of organizationCursor) {
      candidates.push({
        organizationId: String(o._id),
        kind: 'logo',
        key: o.logoKey as string,
        storage: o.logoStorage ?? null,
      });
    }

    for (const c of candidates) {
      if (!c.organizationId) {
        note(null, 'no_organization');
        continue;
      }
      if (!storage || c.storage !== storage) {
        note(c.organizationId, 'other_storage');
        continue;
      }
      const prefix = prefixForKind(c.kind, c.organizationId);
      if (
        !c.key.startsWith(`${prefix}/`) ||
        c.key.length <= prefix.length + 1
      ) {
        note(c.organizationId, 'bad_prefix');
        continue;
      }
      const id = storedObjectId(storage, c.key);
      const existing = await this.objects.findById(id).lean().exec();
      if (existing) {
        note(c.organizationId, 'already_tracked', existing.bytes);
        continue;
      }
      const head = await this.s3.headStoredObject(
        { key: c.key, storage },
        prefix,
      );
      if (head.state === 'absent') {
        note(c.organizationId, 'missing');
        continue;
      }
      if (head.state !== 'present') {
        note(c.organizationId, 'unknown_size');
        continue;
      }
      if (!options.apply) {
        note(c.organizationId, 'to_count', head.bytes);
        continue;
      }
      const outcome = await this.countExisting(
        c.organizationId,
        c.kind,
        c.key,
        storage,
        head.bytes,
      );
      note(c.organizationId, outcome, head.bytes);
    }

    for (const report of perOrg.values()) {
      const usage = await this.usage(report.organizationId);
      report.reservedBytes = usage.reservedBytes;
      report.projectedUsedBytes =
        usage.usedBytes + (options.apply ? 0 : (report.bytes.to_count ?? 0));
      report.overQuota =
        report.projectedUsedBytes + report.reservedBytes >
        this.config.quotaBytes;
    }
    return {
      apply: options.apply,
      storage,
      mode: this.config.mode,
      organizations: [...perOrg.values()].sort((a, b) =>
        a.organizationId.localeCompare(b.organizationId),
      ),
      totals,
      complete: (totals.unknown_size ?? 0) === 0,
    };
  }

  private async countExisting(
    organizationId: string,
    kind: StoredObjectKind,
    key: string,
    storage: string,
    bytes: number,
  ): Promise<'counted' | 'already_tracked' | 'reference_changed'> {
    const organizationOid = new Types.ObjectId(organizationId);
    await this.ensureUsage(organizationOid);
    const id = storedObjectId(storage, key);
    return this.inTransaction(async (session) => {
      // Référence relue et VERROUILLÉE dans la transaction : un fichier
      // détaché entre la lecture et l'écriture n'est pas compté, et un
      // détachement concurrent est sérialisé après ce commit.
      if (!(await this.lockReference({ kind, organizationId, key }, session))) {
        return 'reference_changed' as const;
      }
      const existing = await this.objects
        .findById(id, null, { session })
        .exec();
      if (existing) return 'already_tracked' as const;
      await this.objects.create(
        [
          {
            _id: id,
            organizationId: organizationOid,
            storage,
            key,
            kind,
            bytes,
            state: 'attached',
            leaseUntil: null,
            attempts: 0,
            source: 'initialization',
          },
        ],
        { session },
      );
      await this.usages
        .updateOne(
          { _id: organizationOid },
          { $inc: { storedBytes: bytes, storedObjects: 1 } },
          { session },
        )
        .exec();
      return 'counted' as const;
    });
  }

  // ─── Inventaire du stockage (fichiers non suivis) ─────────────────────

  /**
   * Inventaire du stockage COURANT sous `organizations/<id>/products|
   * branding/` (préfixe exact, `ListObjectsV2`, aucun téléchargement) :
   * retrouve tout fichier présent SANS entrée au registre — envoi arrivé
   * après la reprise de sa réservation, fichier écrit par un code antérieur
   * (retour arrière), fichier antérieur à l'initialisation. Durable : l'état
   * de référence est le stockage lui-même, relu à chaque passe, après tout
   * redémarrage.
   *
   * `apply: false` : diagnostic SANS écriture. `apply: true` : chaque
   * fichier non suivi est COMPTÉ (taille du stockage), dans une transaction
   * qui relit et verrouille sa référence : référencé → `attached` ; sinon
   * → `deleting`, supprimé après un délai de grâce (dernière modification
   * + durée de réservation) par la reprise, qui revérifie la référence ;
   * octets libérés seulement sur suppression confirmée. Relançable : un
   * fichier déjà suivi n'est jamais recompté. Clé hors du schéma attendu :
   * signalée (`foreign_key`), jamais modifiée.
   */
  async reconcileInventory(options: {
    apply: boolean;
    organizationId?: string;
  }): Promise<InventoryReport> {
    const storage = this.s3.storage;
    if (!storage) throw new Error('Stockage non configuré');
    const prefix = options.organizationId
      ? `${ORGANIZATIONS_PREFIX}${options.organizationId}/`
      : ORGANIZATIONS_PREFIX;
    const perOrg = new Map<string, InventoryReport['organizations'][number]>();
    const totals: Partial<Record<InventoryCategory, number>> = {};
    const report: InventoryReport = {
      apply: options.apply,
      storage,
      organizations: [],
      totals,
      deleted: 0,
      pendingDeletion: 0,
    };
    const note = (
      organizationId: string | null,
      category: InventoryCategory,
      bytes: number,
    ) => {
      totals[category] = (totals[category] ?? 0) + 1;
      if (!organizationId) return;
      let row = perOrg.get(organizationId);
      if (!row) {
        row = { organizationId, counts: {}, bytes: {} };
        perOrg.set(organizationId, row);
      }
      row.counts[category] = (row.counts[category] ?? 0) + 1;
      row.bytes[category] = (row.bytes[category] ?? 0) + bytes;
    };

    let token: string | undefined;
    do {
      const page = await this.s3.listStoredObjects(prefix, token);
      for (const object of page.objects) {
        const match = ORGANIZATION_OBJECT_KEY.exec(object.key);
        if (!match) {
          note(null, 'foreign_key', object.bytes);
          continue;
        }
        const organizationId = match[1];
        const kind: StoredObjectKind =
          match[2] === 'branding' ? 'logo' : 'product_image';
        const id = storedObjectId(storage, object.key);
        if (await this.objects.exists({ _id: id }).exec()) {
          note(organizationId, 'tracked', object.bytes);
          continue;
        }
        if (!options.apply) {
          const referenced = await this.isReferenced({
            kind,
            organizationId,
            key: object.key,
          });
          note(
            organizationId,
            referenced ? 'untracked_referenced' : 'untracked_unreferenced',
            object.bytes,
          );
          continue;
        }
        const counted = await this.countUntracked(
          organizationId,
          kind,
          storage,
          object,
        );
        note(organizationId, counted.category, object.bytes);
        if (!counted.entry) continue;
        if (
          counted.entry.leaseUntil &&
          counted.entry.leaseUntil.getTime() <= this.now()
        ) {
          const outcome = await this.recoverEntry(counted.entry).catch(
            () => 'retry' as const,
          );
          if (outcome === 'released') report.deleted += 1;
          else if (outcome === 'retry') report.pendingDeletion += 1;
        } else {
          report.pendingDeletion += 1;
        }
      }
      token = page.next;
    } while (token);

    report.organizations = [...perOrg.values()].sort((a, b) =>
      a.organizationId.localeCompare(b.organizationId),
    );
    return report;
  }

  /** Comptabilise un fichier non suivi (transaction, référence verrouillée). */
  private async countUntracked(
    organizationId: string,
    kind: StoredObjectKind,
    storage: string,
    object: ListedObject,
  ): Promise<{ category: InventoryCategory; entry?: StoredObject }> {
    const organizationOid = new Types.ObjectId(organizationId);
    await this.ensureUsage(organizationOid);
    const id = storedObjectId(storage, object.key);
    return this.inTransaction(async (session) => {
      if (await this.objects.findById(id, null, { session }).exec()) {
        return { category: 'tracked' as const };
      }
      const referenced = await this.lockReference(
        { kind, organizationId, key: object.key },
        session,
      );
      // Délai de grâce compté depuis l'arrivée du fichier : un envoi en
      // cours d'un code qui n'écrit pas au registre peut encore le
      // référencer ; la reprise revérifie avant toute suppression.
      const graceEnds =
        (object.lastModified?.getTime() ?? this.now()) +
        this.config.reservationTtlSeconds * 1000;
      const entry: StoredObject = {
        _id: id,
        organizationId: organizationOid,
        storage,
        key: object.key,
        kind,
        bytes: object.bytes,
        state: referenced ? 'attached' : 'deleting',
        leaseUntil: referenced
          ? null
          : new Date(Math.max(this.now(), graceEnds)),
        attempts: 0,
        source: 'reconciliation',
      };
      await this.objects.create([entry], { session });
      await this.usages
        .updateOne(
          { _id: organizationOid },
          { $inc: { storedBytes: object.bytes, storedObjects: 1 } },
          { session },
        )
        .exec();
      return referenced
        ? { category: 'untracked_referenced' as const }
        : { category: 'untracked_unreferenced' as const, entry };
    });
  }

  // ─── Entrées « attached » sans référence ──────────────────────────────

  /**
   * Détecte les entrées `attached` dont plus aucun document ne référence le
   * fichier (référence retirée par un code antérieur, écriture directe).
   * `apply: false` : diagnostic sans écriture. `apply: true` : pour
   * chacune, en transaction, état ET référence relus (toujours absente) →
   * `deleting` ; puis la reprise revérifie la référence, supprime le fichier
   * et libère SEULEMENT sur suppression confirmée (absence comprise) ;
   * sinon nouvelle échéance, octets toujours comptés. Relançable.
   */
  async reconcileOrphans(options: {
    apply: boolean;
    organizationId?: string;
  }): Promise<OrphanReport> {
    const filter: Record<string, unknown> = { state: 'attached' };
    if (options.organizationId) {
      filter.organizationId = new Types.ObjectId(options.organizationId);
    }
    const report: OrphanReport = {
      apply: options.apply,
      examined: 0,
      orphaned: 0,
      orphanedBytes: 0,
      released: 0,
      reattached: 0,
      retry: 0,
      organizations: [],
    };
    const perOrg = new Map<string, OrphanReport['organizations'][number]>();
    const entries = await this.objects.find(filter).lean().exec();
    for (const entry of entries) {
      report.examined += 1;
      const organizationId = entry.organizationId.toString();
      const ref = { kind: entry.kind, organizationId, key: entry.key };
      if (await this.isReferenced(ref)) continue;
      report.orphaned += 1;
      report.orphanedBytes += entry.bytes;
      const row = perOrg.get(organizationId) ?? {
        organizationId,
        orphaned: 0,
        bytes: 0,
      };
      row.orphaned += 1;
      row.bytes += entry.bytes;
      perOrg.set(organizationId, row);
      if (!options.apply) continue;

      const detached = await this.inTransaction(async (session) => {
        const current = await this.objects
          .findOne({ _id: entry._id, state: 'attached' }, null, { session })
          .exec();
        if (!current) return false;
        if (await this.isReferenced(ref, session)) return false;
        await this.objects
          .updateOne(
            { _id: entry._id, state: 'attached' },
            { $set: { state: 'deleting', leaseUntil: new Date(this.now()) } },
            { session },
          )
          .exec();
        return true;
      });
      if (!detached) {
        report.reattached += 1;
        continue;
      }
      const outcome = await this.recoverEntry({
        ...entry,
        state: 'deleting',
      }).catch(() => 'retry' as const);
      if (outcome === 'released') report.released += 1;
      else if (outcome === 'attached') report.reattached += 1;
      else report.retry += 1;
    }
    report.organizations = [...perOrg.values()].sort((a, b) =>
      a.organizationId.localeCompare(b.organizationId),
    );
    return report;
  }
}
