import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { Product, ProductDocument } from './schemas/product.schema';
import { Sale, SaleDocument } from '../sales/schemas/sale.schema';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { S3Service } from '../s3/s3.service';
import { EventsGateway } from '../events/events.gateway';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { Section, SectionDocument } from '../sections/schemas/section.schema';

export type ProductStatus = 'in_stock' | 'low_stock' | 'out_of_stock';

export interface ProductWithMetrics {
  product: ProductDocument;
  status: ProductStatus;
  unitsSold: number;
  totalPurchaseCost: number;
  estimatedRevenue: number;
  estimatedProfit: number;
}

export interface ProductDetail extends ProductWithMetrics {
  actualRevenue: number;
  actualProfit: number;
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

function computeStatus(remaining: number, initial: number): ProductStatus {
  if (remaining === 0) return 'out_of_stock';
  if (remaining / initial <= 0.2) return 'low_stock';
  return 'in_stock';
}

// Session transactionnelle Mongoose (`mongodb.ClientSession`). Le type est
// dérivé de `Connection.startSession` car le driver `mongodb` n'est pas
// résolvable directement depuis ce workspace pnpm.
type MongooseSession = Awaited<ReturnType<Connection['startSession']>>;

@Injectable()
export class ProductsService {
  constructor(
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    @InjectModel(Sale.name) private saleModel: Model<SaleDocument>,
    @InjectModel(Section.name) private sectionModel: Model<SectionDocument>,
    private s3Service: S3Service,
    private eventsGateway: EventsGateway,
    private auditService: AuditService,
  ) {}

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

  async create(
    organizationId: string,
    dto: CreateProductDto,
    imageUrl: string,
    actorId: string,
  ): Promise<ProductDocument> {
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
    this.eventsGateway.emitToOrganization(
      organizationId,
      'product:created',
      product,
    );
    return product;
  }

  async findAll(
    organizationId: string,
    sectionId?: string,
  ): Promise<ProductWithMetrics[]> {
    const filter: Record<string, unknown> = {
      organizationId: new Types.ObjectId(organizationId),
      deletedAt: null,
    };
    if (sectionId) filter.sectionId = new Types.ObjectId(sectionId);
    const products = await this.productModel
      .find(filter)
      .sort({ createdAt: -1 })
      .exec();
    return products.map((p) => this.withMetrics(p));
  }

  async findOne(
    organizationId: string,
    id: string,
    salesScope: SalesHistoryScope,
    includeAudit: boolean,
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
    const auditLogs = includeAudit
      ? await this.auditService.findByProduct(organizationId, id)
      : [];

    const actualRevenue = sales.reduce(
      (sum, s) => sum + s.salePrice * s.quantity,
      0,
    );
    const unitsSold = product.initialQuantity - product.remainingQuantity;
    const actualProfit = actualRevenue - product.purchasePrice * unitsSold;

    return {
      ...this.withMetrics(product),
      actualRevenue,
      actualProfit,
      sales,
      auditLogs,
    };
  }

  async update(
    organizationId: string,
    id: string,
    dto: UpdateProductDto,
    actorId: string,
    newImageUrl?: string,
  ): Promise<ProductWithMetrics> {
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
    const enriched = this.withMetrics(saved);
    this.eventsGateway.emitToOrganization(
      organizationId,
      'product:updated',
      enriched,
    );
    return enriched;
  }

  async remove(
    organizationId: string,
    id: string,
    actorId: string,
  ): Promise<ProductDocument> {
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
    this.eventsGateway.emitToOrganization(
      organizationId,
      'product:deleted',
      id,
    );
    return product;
  }

  async findTrashed(organizationId: string): Promise<ProductDocument[]> {
    return this.productModel
      .find({
        organizationId: new Types.ObjectId(organizationId),
        deletedAt: { $ne: null },
      })
      .sort({ deletedAt: -1 })
      .exec();
  }

  async restore(organizationId: string, id: string): Promise<ProductDocument> {
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
    this.eventsGateway.emitToOrganization(
      organizationId,
      'product:created',
      product,
    );
    return product;
  }

  async permanentDelete(
    organizationId: string,
    id: string,
  ): Promise<ProductDocument> {
    // §6 — le produit est d'abord localisé par filtre composite tenant :
    // un produit étranger/absent provoque un 404 AVANT tout traitement,
    // donc `s3Service.deleteFile` n'est JAMAIS appelé sur une ressource
    // non rattachée à l'organisation demandée.
    const product = await this.productModel
      .findOne({ _id: id, organizationId: new Types.ObjectId(organizationId) })
      .exec();
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    await this.s3Service.deleteFile(
      product.imageUrl,
      `organizations/${organizationId}/products`,
    );
    const deleted = await this.productModel
      .findOneAndDelete({
        _id: id,
        organizationId: new Types.ObjectId(organizationId),
      })
      .exec();
    return deleted ?? product;
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
      if (!fresh) {
        throw new NotFoundException(`Product ${productId} not found`);
      }
      throw new BadRequestException(
        `Not enough stock. Available: ${fresh.remainingQuantity}`,
      );
    }
    return product;
  }

  private withMetrics(p: ProductDocument): ProductWithMetrics {
    // Guard against NaN if prices are missing (malformed documents)
    const buyPrice = Number(p.purchasePrice) || 0;
    const sellPrice = Number(p.salePrice) || 0;
    const initQty = Number(p.initialQuantity) || 0;
    const remQty = Number(p.remainingQuantity) || 0;
    const unitsSold = initQty - remQty;
    const totalPurchaseCost = buyPrice * initQty;
    const estimatedRevenue = sellPrice * unitsSold;
    const estimatedProfit = estimatedRevenue - buyPrice * unitsSold;
    return {
      product: p,
      status: computeStatus(remQty, initQty),
      unitsSold,
      totalPurchaseCost,
      estimatedRevenue,
      estimatedProfit,
    };
  }
}
