import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { Product, ProductDocument } from './schemas/product.schema';
import { Sale, SaleDocument } from '../sales/schemas/sale.schema';
import { SALE_ERROR_CODES } from '../sales/sale-error-codes';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { S3Service } from '../s3/s3.service';
import { EventsGateway } from '../events/events.gateway';
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

export type { ProductStatus } from './product-projection';

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
    return products.map((p) =>
      toProductMetricsView(
        p,
        visibility,
        visibility.financials
          ? (revenues.get(p._id.toString()) ?? 0)
          : undefined,
      ),
    );
  }

  async create(
    organizationId: string,
    dto: CreateProductDto,
    imageUrl: string,
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
    const product = await this.productModel.create({
      organizationId: new Types.ObjectId(organizationId),
      sectionId: new Types.ObjectId(dto.sectionId),
      name: dto.name,
      imageUrl,
      purchasePrice: dto.purchasePrice,
      salePrice: dto.salePrice,
      initialQuantity: dto.initialQuantity,
      remainingQuantity: dto.initialQuantity,
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
    // 1-12H — diffusion commune : champs standard uniquement.
    this.emitBestEffort(
      organizationId,
      'product:created',
      toProductMetricsView(product, COMMON_VISIBILITY),
    );
    return toProductView(product, visibility);
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
    newImageUrl?: string,
    visibility: ProductVisibility = COMMON_VISIBILITY,
  ): Promise<ProductMetricsView> {
    // §4 — relecture composite tenant : produit étranger = 404, pas de fuite.
    const product = await this.productModel
      .findOne({
        _id: id,
        organizationId: new Types.ObjectId(organizationId),
      })
      .exec();
    if (!product) throw new NotFoundException(`Product ${id} not found`);

    const changes: Record<string, unknown> = {};
    const previousImageUrl = product.imageUrl;
    if (newImageUrl) product.imageUrl = newImageUrl;

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

    if (dto.additionalStock && dto.additionalStock > 0) {
      const stockChange = { added: dto.additionalStock };
      product.initialQuantity += dto.additionalStock;
      product.remainingQuantity += dto.additionalStock;
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

    // §5 — `organizationId` n'est JAMAIS attribuée ici : le $set implicite de
    // `save()` ne porte que les champs mutés ci-dessus.
    const saved = await product.save();
    // Ancienne image supprimée SEULEMENT après succès de la mutation.
    if (newImageUrl && previousImageUrl !== newImageUrl) {
      await this.s3Service.deleteFile(
        previousImageUrl,
        `organizations/${organizationId}/products`,
      );
    }
    // 1-12H — diffusion commune (standard seul) ; chaque client recharge
    // ses champs étendus via l'API selon ses propres permissions.
    this.emitBestEffort(
      organizationId,
      'product:updated',
      toProductMetricsView(saved, COMMON_VISIBILITY),
    );
    const [view] = await this.toMetricsViews(
      organizationId,
      [saved],
      visibility,
    );
    return view;
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
    return toProductView(product, visibility);
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
    return products.map((p) => toProductView(p, visibility));
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
    this.emitBestEffort(
      organizationId,
      'product:created',
      toProductMetricsView(product, COMMON_VISIBILITY),
    );
    return toProductView(product, visibility);
  }

  async permanentDelete(
    organizationId: string,
    id: string,
    visibility: ProductVisibility = COMMON_VISIBILITY,
  ): Promise<ProductView> {
    const orgOid = new Types.ObjectId(organizationId);
    // §6 — le produit est d'abord localisé par filtre composite tenant :
    // un produit étranger/absent provoque un 404 AVANT tout traitement,
    // donc `s3Service.deleteFile` n'est JAMAIS appelé sur une ressource
    // non rattachée à l'organisation demandée.
    const product = await this.productModel
      .findOne({ _id: id, organizationId: orgOid })
      .exec();
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    // Fichier supprimé AVANT et HORS de la transaction (jamais dans un
    // callback rejouable) : un échec ultérieur laisse le produit en place et
    // la purge reste relançable, sans fichier orphelin.
    await this.s3Service.deleteFile(
      product.imageUrl,
      `organizations/${organizationId}/products`,
    );
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
        removed = target;
      });
    } finally {
      await session.endSession();
    }
    // 1-15B — suppression DÉFINITIVE, distincte de la mise à la corbeille
    // (`product:deleted`) : le produit n'est plus restaurable. Identifiant
    // seul, émis seulement si cette requête a réellement supprimé le
    // document (aucune émission sur 404 ni sur échec), après le commit.
    if (removed) {
      this.emitBestEffort(organizationId, 'product:purged', {
        _id: String(removed._id),
      });
    }
    return toProductView(removed ?? product, visibility);
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

  /** Adjusts remainingQuantity by delta (positive = restore, negative = consume) */
  async adjustStock(
    organizationId: string,
    productId: string,
    delta: number,
    session?: MongooseSession,
  ): Promise<void> {
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
    product.remainingQuantity += delta;
    await product.save({ session: session ?? null });
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
