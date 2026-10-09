import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { UpdateQuery } from 'mongoose';
import type { Connection } from 'mongoose';
import { Product, ProductDocument } from './schemas/product.schema';
import { Sale, SaleDocument } from '../sales/schemas/sale.schema';
import { SALE_ERROR_CODES } from '../sales/sale-error-codes';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import {
  S3Service,
  type StorageCleanup,
  type StoredObjectRef,
} from '../s3/s3.service';
import { EventsGateway } from '../events/events.gateway';
import {
  StorageQuotaService,
  type StagedObject,
} from '../storage-quota/storage-quota.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { Section, SectionDocument } from '../sections/schemas/section.schema';
import {
  PurgedStockAdjustment,
  PurgedStockAdjustmentDocument,
} from './schemas/purged-stock-adjustment.schema';
import {
  COMMON_VISIBILITY,
  ProductMetricsView,
  ProductView,
  ProductVisibility,
  projectAuditDetails,
  toProductMetricsView,
  toProductView,
} from './product-projection';

import { productImagePrefix } from '../storage-quota/storage-prefixes';

export type { ProductStatus } from './product-projection';

/** Préfixe des photos d'une organisation (clé serveur, jamais cliente). */
export { productImagePrefix };

/** Ancienne URL (avant R2) : renvoyée telle quelle si http(s), jamais convertie. */
function legacyImageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Champs de photo lus sur un document produit. */
interface ProductImageFields {
  imageUrl?: string | null;
  imageKey?: string | null;
  imageStorage?: string | null;
}

function storedImageRef(p: ProductImageFields): StoredObjectRef | null {
  return p.imageKey
    ? { key: p.imageKey, storage: p.imageStorage ?? null }
    : null;
}

/** Sort du fichier précédent, renvoyé avec la réponse (jamais un succès supposé). */
export interface StorageCleanupResult {
  storageCleanup: StorageCleanup;
}

/** 1-16A.1 — résultat d'un ajustement de stock (détection des seuils). */
export interface StockAdjustment {
  initialQuantity: number;
  remainingBefore: number;
  remainingAfter: number;
}

export interface ProductDetail extends ProductMetricsView {
  sales: SaleDocument[];
  auditLogs: unknown[];
}

/**
 * 1-7B (correctif) — scope de l'historique des ventes exposé par
 * `findOne` : décidé par le contrôleur (permissions `sales.view_all` /
 * `sales.view_own`), jamais par le service.
 */
export type SalesHistoryScope =
  { kind: 'all' } | { kind: 'own'; sellerId: string } | { kind: 'none' };

// Session transactionnelle Mongoose (`mongodb.ClientSession`). Le type est
// dérivé de `Connection.startSession` car le driver `mongodb` n'est pas
// résolvable directement depuis ce workspace pnpm.
type MongooseSession = Awaited<ReturnType<Connection['startSession']>>;

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    @InjectModel(Sale.name) private saleModel: Model<SaleDocument>,
    @InjectModel(Section.name) private sectionModel: Model<SectionDocument>,
    private s3Service: S3Service,
    private eventsGateway: EventsGateway,
    private auditService: AuditService,
    @InjectConnection() private connection: Connection,
    @InjectModel(PurgedStockAdjustment.name)
    private stockAdjustmentModel: Model<PurgedStockAdjustmentDocument>,
    private storageQuota: StorageQuotaService,
  ) {}

  /**
   * 1-15A — diffusion APRÈS l'écriture, en best effort (comme les ventes) :
   * une panne d'émission ne transforme jamais une mutation déjà écrite en
   * erreur (le client pourrait sinon la rejouer). Les autres membres
   * rattrapent l'état par relecture à leur prochaine connexion du socket.
   */
  private emitBestEffort(
    organizationId: string,
    event:
      | 'product:created'
      | 'product:updated'
      | 'product:deleted'
      | 'product:purged',
    payload: unknown,
  ): void {
    try {
      this.eventsGateway.emitToOrganization(organizationId, event, payload);
    } catch {
      this.logger.warn(`${event} non émis (best effort).`);
    }
  }

  /** Throws 409 if another product (OF THE SAME TENANT) shares the name */
  private async assertUniqueProductName(
    organizationId: string,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const query: Record<string, unknown> = {
      name: new RegExp(`^${escaped}$`, 'i'),
      organizationId: new Types.ObjectId(organizationId),
    };
    if (excludeId) query._id = { $ne: new Types.ObjectId(excludeId) };
    const existing = await this.productModel.findOne(query).exec();
    if (existing) {
      throw new ConflictException({
        message: 'DUPLICATE_PRODUCT',
        existing: {
          _id: existing._id,
          name: existing.name,
          deletedAt: existing.deletedAt,
          sectionId: existing.sectionId,
        },
      });
    }
  }

  /**
   * 1-12H — CA réel par produit : agrégat serveur sur TOUTES les ventes
   * existantes du produit dans l'organisation (Σ prix appliqué × quantité),
   * indépendant du vendeur connecté et de toute liste filtrée ou paginée.
   * Une vente modifiée compte avec ses valeurs courantes ; une vente
   * supprimée (suppression physique + stock restauré) n'est plus comptée.
   */
  private async actualRevenueByProduct(
    organizationId: string,
    productIds: Types.ObjectId[],
  ): Promise<Map<string, number>> {
    if (productIds.length === 0) return new Map();
    const rows = await this.saleModel
      .aggregate<{ _id: Types.ObjectId; revenue: number }>([
        {
          $match: {
            organizationId: new Types.ObjectId(organizationId),
            productId: { $in: productIds },
          },
        },
        {
          $group: {
            _id: '$productId',
            revenue: { $sum: { $multiply: ['$salePrice', '$quantity'] } },
          },
        },
      ])
      .exec();
    return new Map(rows.map((r) => [r._id.toString(), r.revenue]));
  }

  /** Projection pour le demandeur ; l'agrégat n'est lu que si `financials`. */
  private async toMetricsViews(
    organizationId: string,
    products: ProductDocument[],
    visibility: ProductVisibility,
  ): Promise<ProductMetricsView[]> {
    const revenues = visibility.financials
      ? await this.actualRevenueByProduct(
          organizationId,
          products.map((p) => p._id),
        )
      : new Map<string, number>();
    const images = await Promise.all(
      products.map((p) => this.imageUrlFor(organizationId, p)),
    );
    return products.map((p, index) =>
      toProductMetricsView(
        p,
        visibility,
        images[index],
        visibility.financials
          ? (revenues.get(p._id.toString()) ?? 0)
          : undefined,
      ),
    );
  }

  /**
   * URL de lecture d'une photo, calculée À CHAQUE réponse pour un produit
   * déjà lu dans l'organisation du demandeur : signée (durée explicite) si
   * la photo est dans le stockage courant et sous le préfixe exact de cette
   * organisation ; ancienne URL telle quelle sinon ; `null` si aucune.
   */
  private async imageUrlFor(
    organizationId: string,
    p: ProductImageFields,
  ): Promise<string | null> {
    const ref = storedImageRef(p);
    if (ref) {
      return this.s3Service.signedReadUrl(
        ref,
        productImagePrefix(organizationId),
      );
    }
    return legacyImageUrl(p.imageUrl);
  }

  /** Une photo est-elle référencée par un produit de l'organisation ? */
  async isImageReferenced(
    organizationId: string,
    key: string,
  ): Promise<boolean> {
    const found = await this.productModel
      .exists({
        organizationId: new Types.ObjectId(organizationId),
        imageKey: key,
      })
      .exec();
    return found !== null;
  }

  /**
   * 1-17B — Remplacement refusé par l'écriture conditionnelle : produit
   * absent → 404 (inchangé) ; photo modifiée entre-temps par une autre
   * requête → 409 stable, rien n'est écrit (la nouvelle photo est
   * abandonnée par le contrôleur).
   */
  private async assertImageUnchanged(filter: {
    _id: Types.ObjectId;
    organizationId: Types.ObjectId | null;
  }): Promise<never> {
    const exists = await this.productModel.exists(filter).exec();
    if (!exists) {
      throw new NotFoundException(`Product ${String(filter._id)} not found`);
    }
    throw new ConflictException({
      code: 'PRODUCT_IMAGE_CONFLICT',
      message:
        'La photo de ce produit vient d’être modifiée. Rechargez puis réessayez.',
    });
  }

  /**
   * Suppression APRÈS l'écriture MongoDB. Une ancienne URL (avant R2) n'est
   * jamais supprimée : son stockage n'est pas celui de la configuration.
   * 1-17B : l'espace n'est libéré qu'après suppression confirmée ; un échec
   * laisse le fichier compté et sa suppression reprise plus tard.
   */
  private async cleanupPreviousImage(
    organizationId: string,
    previous: ProductImageFields,
  ): Promise<StorageCleanup> {
    const ref = storedImageRef(previous);
    if (!ref) return previous.imageUrl ? 'retained' : 'not_needed';
    return this.storageQuota.deleteDetached(
      organizationId,
      ref,
      productImagePrefix(organizationId),
    );
  }

  /** Transaction courte (aucun appel au stockage à l'intérieur). */
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

  async create(
    organizationId: string,
    dto: CreateProductDto,
    image: StagedObject,
    actorId: string,
    visibility: ProductVisibility = COMMON_VISIBILITY,
  ): Promise<ProductView> {
    // §5 — la section cible doit être une section ACTIVE de la MÊME
    // organisation. Filtre composite tenant : une section étrangère/absente
    // est indistinguable d'une section absente (même 404, pas de fuite).
    const section = await this.sectionModel
      .findOne({
        _id: new Types.ObjectId(dto.sectionId),
        organizationId: new Types.ObjectId(organizationId),
        deletedAt: null,
      })
      .exec();
    if (!section) {
      throw new NotFoundException(`Section ${dto.sectionId} not found`);
    }

    // Aucune sous-section active n'autorise un produit (§1-4A inchangé,
    // désormais filtré par tenant).
    const subSectionCount = await this.sectionModel
      .countDocuments({
        organizationId: new Types.ObjectId(organizationId),
        parentId: new Types.ObjectId(dto.sectionId),
        deletedAt: null,
      })
      .exec();
    if (subSectionCount > 0) {
      throw new BadRequestException('SECTION_HAS_SUBSECTIONS');
    }

    await this.assertUniqueProductName(organizationId, dto.name);

    // §5 — liste de champs EXPLICITE : jamais un spread du DTO, qui pourrait
    // porter un `organizationId` falsifié. L'org est imposée par le SERVEUR.
    // 1-17B : création et rattachement de la photo comptabilisée dans la
    // MÊME transaction (jamais une référence sans fichier compté).
    const product = await this.inTransaction(async (session) => {
      const [created] = await this.productModel.create(
        [
          {
            organizationId: new Types.ObjectId(organizationId),
            sectionId: new Types.ObjectId(dto.sectionId),
            name: dto.name,
            imageKey: image.key,
            imageStorage: image.storage,
            purchasePrice: dto.purchasePrice,
            salePrice: dto.salePrice,
            initialQuantity: dto.initialQuantity,
            remainingQuantity: dto.initialQuantity,
          },
        ],
        { session },
      );
      await this.storageQuota.attach(image, session);
      return created;
    });
    await this.auditService.log(
      organizationId,
      product._id,
      AuditAction.CREATED,
      actorId,
      {
        name: dto.name,
        purchasePrice: dto.purchasePrice,
        salePrice: dto.salePrice,
        initialQuantity: dto.initialQuantity,
      },
    );
    // 1-12H — diffusion commune : champs standard uniquement (photo signée,
    // room de l'organisation seulement).
    const imageUrl = await this.imageUrlFor(organizationId, product);
    this.emitBestEffort(
      organizationId,
      'product:created',
      toProductMetricsView(product, COMMON_VISIBILITY, imageUrl),
    );
    return toProductView(product, visibility, imageUrl);
  }

  async findAll(
    organizationId: string,
    sectionId?: string,
    visibility: ProductVisibility = COMMON_VISIBILITY,
  ): Promise<ProductMetricsView[]> {
    const filter: Record<string, unknown> = {
      organizationId: new Types.ObjectId(organizationId),
      deletedAt: null,
    };
    if (sectionId) filter.sectionId = new Types.ObjectId(sectionId);
    const products = await this.productModel
      .find(filter)
      .sort({ createdAt: -1 })
      .exec();
    return this.toMetricsViews(organizationId, products, visibility);
  }

  async findOne(
    organizationId: string,
    id: string,
    salesScope: SalesHistoryScope,
    includeAudit: boolean,
    visibility: ProductVisibility = COMMON_VISIBILITY,
  ): Promise<ProductDetail> {
    // §4 — filtre composite tenant : un produit d'une autre org est
    // indistinguable d'un produit absent (même 404).
    const product = await this.productModel
      .findOne({
        _id: id,
        organizationId: new Types.ObjectId(organizationId),
      })
      .exec();
    if (!product) throw new NotFoundException(`Product ${id} not found`);

    // Correctif 1-7B — ni interrogé ni exposé hors du scope autorisé :
    // `none` ne lit AUCUNE vente, `own` filtre par vendeur courant.
    let sales: SaleDocument[] = [];
    if (salesScope.kind !== 'none') {
      const filter: Record<string, Types.ObjectId> = {
        productId: new Types.ObjectId(id),
      };
      if (salesScope.kind === 'own') {
        filter.sellerId = new Types.ObjectId(salesScope.sellerId);
      }
      sales = await this.saleModel
        .find(filter)
        .populate('sellerId', 'name email')
        .sort({ createdAt: -1 })
        .exec();
    }

    // Correctif 1-7B — `audit.read` absent : aucune lecture, jamais un vidage
    // après coup (l'historique n'est même pas interrogé).
    // 1-12H — détails d'audit projetés selon la même visibilité.
    const auditLogs = includeAudit
      ? (await this.auditService.findByProduct(organizationId, id)).map(
          (log) => {
            const plain = log.toObject();
            return {
              ...plain,
              details: projectAuditDetails(plain.details, visibility),
            };
          },
        )
      : [];

    // 1-12H (correctif) — les agrégats ne dépendent JAMAIS de `sales`
    // (historique scopé own/all) : agrégat serveur sur toutes les ventes du
    // produit, uniquement pour `products.view_financials`.
    const [metrics] = await this.toMetricsViews(
      organizationId,
      [product],
      visibility,
    );

    return { ...metrics, sales, auditLogs };
  }

  async update(
    organizationId: string,
    id: string,
    dto: UpdateProductDto,
    actorId: string,
    newImage?: StagedObject,
    visibility: ProductVisibility = COMMON_VISIBILITY,
  ): Promise<ProductMetricsView & Partial<StorageCleanupResult>> {
    // §4 — relecture composite tenant : produit étranger = 404, pas de fuite.
    const product = await this.productModel
      .findOne({
        _id: id,
        organizationId: new Types.ObjectId(organizationId),
      })
      .exec();
    if (!product) throw new NotFoundException(`Product ${id} not found`);

    const changes: Record<string, unknown> = {};
    // Ancienne photo : lue AVANT la mutation, supprimée APRÈS l'écriture.
    // Une ancienne URL (avant R2) reste telle quelle en base.
    const previousImage: ProductImageFields = {
      imageUrl: product.imageUrl,
      imageKey: product.imageKey,
      imageStorage: product.imageStorage,
    };
    if (newImage) {
      product.imageKey = newImage.key;
      product.imageStorage = newImage.storage;
    }

    if (dto.name && dto.name !== product.name) {
      changes.name = { from: product.name, to: dto.name };
      product.name = dto.name;
      await this.auditService.log(
        organizationId,
        id,
        AuditAction.NAME_CHANGED,
        actorId,
        changes,
      );
    }

    if (dto.purchasePrice !== undefined || dto.salePrice !== undefined) {
      if (
        dto.purchasePrice !== undefined &&
        dto.purchasePrice !== product.purchasePrice
      ) {
        changes.purchasePrice = {
          from: product.purchasePrice,
          to: dto.purchasePrice,
        };
        product.purchasePrice = dto.purchasePrice;
      }
      if (dto.salePrice !== undefined && dto.salePrice !== product.salePrice) {
        changes.salePrice = { from: product.salePrice, to: dto.salePrice };
        product.salePrice = dto.salePrice;
      }
      if (Object.keys(changes).length) {
        await this.auditService.log(
          organizationId,
          id,
          AuditAction.PRICE_CHANGED,
          actorId,
          changes,
        );
      }
    }

    // 1-15E — l'ajout n'est PAS appliqué au document lu (valeurs absolues
    // périmées si une vente est validée entre-temps) : il est transmis en
    // `$inc` à l'écriture atomique ci-dessous, comme `decrementStock`.
    let addedStock = 0;
    if (dto.additionalStock && dto.additionalStock > 0) {
      addedStock = dto.additionalStock;
      const stockChange = { added: dto.additionalStock };
      await this.auditService.log(
        organizationId,
        id,
        AuditAction.STOCK_CHANGED,
        actorId,
        stockChange,
      );
    }

    if (dto.sectionId) {
      const newId = new Types.ObjectId(dto.sectionId);
      if (!product.sectionId.equals(newId)) {
        // §5 — la section cible doit être ACTIVE de la MÊME organisation.
        // Un mouvement vers une section étrangère est refusé (même 404 que
        // l'absente) : aucun état partiel n'est jamais sauvegardé.
        const target = await this.sectionModel
          .findOne({
            _id: newId,
            organizationId: new Types.ObjectId(organizationId),
            deletedAt: null,
          })
          .exec();
        if (!target) {
          throw new NotFoundException(`Section ${dto.sectionId} not found`);
        }
        changes.sectionId = { from: product.sectionId, to: newId };
        product.sectionId = newId;
        await this.auditService.log(
          organizationId,
          id,
          AuditAction.SECTION_CHANGED,
          actorId,
          changes,
        );
      }
    }

    // 1-15E — UNE écriture atomique d'un seul document, filtrée par tenant :
    // `$set` des seuls champs mutés ci-dessus (ceux qu'aurait écrits
    // `save()` ; `organizationId` n'en fait JAMAIS partie) et `$inc` du
    // stock. Une vente validée pendant la modification n'est donc jamais
    // écrasée ; aucune relecture ni reprise applicative (un ajout ne peut
    // être appliqué deux fois). Produit supprimé entre-temps → 404, rien
    // n'est recréé.
    const update: UpdateQuery<ProductDocument> = {
      ...product.$getChanges(),
      ...(addedStock > 0
        ? {
            $inc: {
              initialQuantity: addedStock,
              remainingQuantity: addedStock,
            },
          }
        : {}),
    };
    const filter = { _id: product._id, organizationId: product.organizationId };
    let saved: ProductDocument | null;
    if (newImage) {
      // 1-17B — remplacement de photo : écriture conditionnée à la photo LUE
      // (deux remplacements concurrents ne laissent jamais un fichier
      // orphelin non suivi), rattachement de la nouvelle et détachement de
      // l'ancienne dans la MÊME transaction. Aucun appel au stockage ici.
      saved = await this.inTransaction(async (session) => {
        const written = await this.productModel
          .findOneAndUpdate(
            { ...filter, imageKey: previousImage.imageKey ?? null },
            update,
            { returnDocument: 'after', runValidators: true, session },
          )
          .exec();
        if (!written) return null;
        await this.storageQuota.attach(newImage, session);
        await this.storageQuota.detach(
          organizationId,
          storedImageRef(previousImage),
          session,
        );
        return written;
      });
      if (!saved) await this.assertImageUnchanged(filter);
    } else {
      saved =
        Object.keys(update).length === 0
          ? product
          : await this.productModel
              .findOneAndUpdate(filter, update, {
                returnDocument: 'after',
                runValidators: true,
              })
              .exec();
    }
    if (!saved) throw new NotFoundException(`Product ${id} not found`);
    // Ancienne photo supprimée SEULEMENT après succès de la mutation ; son
    // sort est renvoyé tel quel (un échec n'est jamais présenté comme une
    // suppression).
    const storageCleanup = newImage
      ? await this.cleanupPreviousImage(organizationId, previousImage)
      : undefined;
    // 1-12H — diffusion commune (standard seul) ; chaque client recharge
    // ses champs étendus via l'API selon ses propres permissions.
    const imageUrl = await this.imageUrlFor(organizationId, saved);
    this.emitBestEffort(
      organizationId,
      'product:updated',
      toProductMetricsView(saved, COMMON_VISIBILITY, imageUrl),
    );
    const [view] = await this.toMetricsViews(
      organizationId,
      [saved],
      visibility,
    );
    return storageCleanup ? { ...view, storageCleanup } : view;
  }

  async remove(
    organizationId: string,
    id: string,
    actorId: string,
    visibility: ProductVisibility = COMMON_VISIBILITY,
  ): Promise<ProductView> {
    // §4 — suppression douce composite tenant : le filtre inclut l'org ; un
    // produit étranger est indistinguable d'un produit absent (même 404).
    const product = await this.productModel
      .findOneAndUpdate(
        { _id: id, organizationId: new Types.ObjectId(organizationId) },
        { $set: { deletedAt: new Date() } },
        // `returnDocument: 'after'` = l'ancienne option `new: true` (dépréciée).
        { returnDocument: 'after' },
      )
      .exec();
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    await this.auditService.log(
      organizationId,
      id,
      AuditAction.DELETED,
      actorId,
      {
        name: product.name,
      },
    );
    this.emitBestEffort(organizationId, 'product:deleted', id);
    return toProductView(
      product,
      visibility,
      await this.imageUrlFor(organizationId, product),
    );
  }

  async findTrashed(
    organizationId: string,
    visibility: ProductVisibility = COMMON_VISIBILITY,
  ): Promise<ProductView[]> {
    const products = await this.productModel
      .find({
        organizationId: new Types.ObjectId(organizationId),
        deletedAt: { $ne: null },
      })
      .sort({ deletedAt: -1 })
      .exec();
    const images = await Promise.all(
      products.map((p) => this.imageUrlFor(organizationId, p)),
    );
    return products.map((p, index) =>
      toProductView(p, visibility, images[index]),
    );
  }

  async restore(
    organizationId: string,
    id: string,
    visibility: ProductVisibility = COMMON_VISIBILITY,
  ): Promise<ProductView> {
    // §4 — MÊME filtre composite que `remove` : seul un produit de l'org
    // demandée est restaurable ; l'étranger est indistinguable de l'absent.
    const product = await this.productModel
      .findOneAndUpdate(
        { _id: id, organizationId: new Types.ObjectId(organizationId) },
        { $set: { deletedAt: null } },
        // `returnDocument: 'after'` = option `new: true` dépréciée en Mongoose 9.
        { returnDocument: 'after' },
      )
      .exec();
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    const imageUrl = await this.imageUrlFor(organizationId, product);
    this.emitBestEffort(
      organizationId,
      'product:created',
      toProductMetricsView(product, COMMON_VISIBILITY, imageUrl),
    );
    return toProductView(product, visibility, imageUrl);
  }

  async permanentDelete(
    organizationId: string,
    id: string,
    visibility: ProductVisibility = COMMON_VISIBILITY,
  ): Promise<ProductView & StorageCleanupResult> {
    const orgOid = new Types.ObjectId(organizationId);
    // §6 — le produit est d'abord localisé par filtre composite tenant :
    // un produit étranger/absent provoque un 404 AVANT tout traitement :
    // aucun fichier d'une autre organisation n'est jamais touché.
    const product = await this.productModel
      .findOne({ _id: id, organizationId: orgOid })
      .exec();
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    // 1-15D — suppression du document ET conservation de l'historique de
    // ses ventes dans la MÊME transaction. Une vente concurrente écrit le
    // même document produit (décrément du stock) : l'une des deux
    // transactions est rejouée par le pilote. Toute vente validée avant la
    // suppression est donc couverte ; aucune ne peut l'être après (produit
    // introuvable → 404).
    let removed: ProductDocument | undefined;
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        removed = undefined;
        const target = await this.productModel
          .findOneAndDelete({ _id: id, organizationId: orgOid }, { session })
          .exec();
        if (!target) return;
        await this.preserveSaleHistory(orgOid, target, session);
        await this.preserveStockContribution(orgOid, target, session);
        // 1-17B : fichier détaché (toujours compté) dans la transaction ;
        // libéré seulement après sa suppression confirmée, hors transaction.
        await this.storageQuota.detach(
          organizationId,
          storedImageRef(target),
          session,
        );
        removed = target;
      });
    } finally {
      await session.endSession();
    }
    // 1-15B — suppression DÉFINITIVE, distincte de la mise à la corbeille
    // (`product:deleted`) : le produit n'est plus restaurable. Identifiant
    // seul, émis seulement si cette requête a réellement supprimé le
    // document (aucune émission sur 404 ni sur échec), après le commit.
    // Fichier supprimé APRÈS le commit, HORS de la transaction (jamais dans
    // un callback rejouable), et seulement par la requête qui a réellement
    // supprimé le document. Un échec de suppression laisse un objet orphelin
    // journalisé et renvoyé (`failed`), jamais un succès supposé.
    const storageCleanup = removed
      ? await this.cleanupPreviousImage(organizationId, removed)
      : 'not_needed';
    if (removed) {
      this.emitBestEffort(organizationId, 'product:purged', {
        _id: String(removed._id),
      });
    }
    return {
      ...toProductView(removed ?? product, visibility, null),
      storageCleanup,
    };
  }

  /**
   * 1-15D — fige, sur les ventes du produit supprimé, le dernier nom connu
   * et le prix d'achat unitaire que les analyses utilisaient jusque-là.
   * Valeurs lues dans le document supprimé (serveur), jamais chez le
   * client. Idempotent : une vente déjà marquée (`lastKnownSource`) n'est
   * jamais réécrite ; `productName` (nom enregistré à la vente) n'est
   * jamais touché. Aucun fichier copié.
   */
  private async preserveSaleHistory(
    organizationOid: Types.ObjectId,
    product: ProductDocument,
    session: MongooseSession,
  ): Promise<void> {
    await this.saleModel
      .updateMany(
        {
          organizationId: organizationOid,
          productId: product._id,
          lastKnownSource: { $exists: false },
        },
        {
          $set: {
            lastKnownProductName: product.name,
            lastKnownUnitCost: product.purchasePrice,
            lastKnownSource: 'purge',
          },
        },
        { session },
      )
      .exec();
  }

  /**
   * 1-15D — conservation EXACTE de la contribution du produit au coût des
   * ventes de la vue d'ensemble (règle existante : prix d'achat × (stock
   * initial − stock restant)). Après la purge, ce coût est porté par les
   * ventes (prix figé × quantités) ; si les deux quantités ont divergé
   * (écriture perdue, données anciennes), l'écart est figé dans la même
   * transaction. Lecture des ventes dans la session : même instantané que
   * la suppression.
   */
  private async preserveStockContribution(
    organizationOid: Types.ObjectId,
    product: ProductDocument,
    session: MongooseSession,
  ): Promise<void> {
    const [sold] = await this.saleModel
      .aggregate<{ units: number }>([
        { $match: { organizationId: organizationOid, productId: product._id } },
        { $group: { _id: null, units: { $sum: '$quantity' } } },
      ])
      .session(session)
      .exec();
    const units =
      product.initialQuantity - product.remainingQuantity - (sold?.units ?? 0);
    if (units === 0) return;
    await this.stockAdjustmentModel.create(
      [
        {
          organizationId: organizationOid,
          productId: product._id,
          unitCost: product.purchasePrice,
          units,
        },
      ],
      { session },
    );
  }

  /**
   * Adjusts remainingQuantity by delta (positive = restore, negative = consume).
   * 1-16A / 1-16A.1 : renvoie le stock initial et le stock restant avant /
   * après ajustement (même lecture, même session), ou `undefined` si le
   * produit n'existe plus (aucun ajustement, comme avant).
   */
  async adjustStock(
    organizationId: string,
    productId: string,
    delta: number,
    session?: MongooseSession,
  ): Promise<StockAdjustment | undefined> {
    const product = await this.productModel
      .findOne(
        {
          _id: new Types.ObjectId(productId),
          organizationId: new Types.ObjectId(organizationId),
        },
        null,
        { session: session ?? null },
      )
      .exec();
    if (!product) return; // product may have been permanently deleted
    if (product.remainingQuantity + delta < 0) {
      throw new BadRequestException(
        `Insufficient stock. Available: ${product.remainingQuantity}`,
      );
    }
    const remainingBefore = product.remainingQuantity;
    product.remainingQuantity += delta;
    await product.save({ session: session ?? null });
    return {
      initialQuantity: product.initialQuantity,
      remainingBefore,
      remainingAfter: product.remainingQuantity,
    };
  }

  /**
   * Décrémente le stock de manière ATOMIQUE et conditionnelle.
   *
   * Le filtre `remainingQuantity >= quantity` sur la `findOneAndUpdate` garantit
   * qu'aucune vente ne peut amener un stock négatif, même en concurrence :
   * deux mises à jour concurrentes sur le dernier article, seule la première
   * trouve une ligne et la décrémentent, la seconde obtient `modifiedCount = 0`
   * et provoque le rollback de la transaction appelante.
   *
   * Quand une `session` transactionnelle est fournie, la mise à jour ET la
   * relecture d'erreur sont exécutées dans cette session : le décompte est
   * validé ou annulé avec le reste de la transaction vente–stock–audit.
   *
   * Si aucune ligne n'est modifiée, on relit le produit AVEC la même session
   * pour distinguer : produit absent/inaccessible → 404 (message actuel),
   * produit présent mais stock insuffisant → 400 `Not enough stock. Available: N`.
   *
   * 1-4C.1 — TENANT : le filtre atomique ET la relecture d'échec sont
   * composites (`_id` + `organizationId`) : un produit d'une autre org est
   * indistinguable d'un produit absent, le décompte ne se fait jamais sur un
   * stock étranger. `organizationId` est le 1er argument OBLIGATOIRE — la
   * décrémentation n'est plus invocable sans org (résiduel `adjustStock`,
   * non tenant, reporté à 1-4C.2).
   */
  async decrementStock(
    organizationId: string,
    productId: string,
    quantity: number,
    session?: MongooseSession,
  ): Promise<ProductDocument> {
    const objectId = new Types.ObjectId(productId);
    const orgOid = new Types.ObjectId(organizationId);
    const product = await this.productModel
      .findOneAndUpdate(
        {
          _id: objectId,
          organizationId: orgOid,
          deletedAt: null,
          remainingQuantity: { $gte: quantity },
        },
        { $inc: { remainingQuantity: -quantity } },
        // `returnDocument: 'after'` = l'ancienne option `new: true` (dépréciée
        // depuis Mongoose 9) : renvoie le document APRÈS la mise à jour.
        { returnDocument: 'after', session: session ?? null },
      )
      .exec();

    if (!product) {
      // Aucune mise à jour n'a correspondu au filtre. Relecture d'un produit
      // ACTIF du MÊME tenant (même session) pour distinguer : présent mais
      // stock insuffisant → 400, absent, étranger ou déjà corbeillé → 404.
      const fresh = await this.productModel
        .findOne(
          { _id: objectId, organizationId: orgOid, deletedAt: null },
          null,
          { session: session ?? null },
        )
        .exec();
      // 1-11C.1 : codes stables ajoutés, messages historiques inchangés.
      if (!fresh) {
        throw new NotFoundException({
          code: SALE_ERROR_CODES.PRODUCT_NOT_FOUND,
          message: `Product ${productId} not found`,
        });
      }
      throw new BadRequestException({
        code: SALE_ERROR_CODES.INSUFFICIENT_STOCK,
        message: `Not enough stock. Available: ${fresh.remainingQuantity}`,
        available: fresh.remainingQuantity,
      });
    }
    return product;
  }
}
