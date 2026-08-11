import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Product, ProductDocument } from './schemas/product.schema';
import { Sale, SaleDocument } from '../sales/schemas/sale.schema';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { S3Service } from '../s3/s3.service';
import { EventsGateway } from '../events/events.gateway';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';

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

function computeStatus(remaining: number, initial: number): ProductStatus {
  if (remaining === 0) return 'out_of_stock';
  if (remaining / initial <= 0.2) return 'low_stock';
  return 'in_stock';
}

@Injectable()
export class ProductsService {
  constructor(
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    @InjectModel(Sale.name) private saleModel: Model<SaleDocument>,
    private s3Service: S3Service,
    private eventsGateway: EventsGateway,
    private auditService: AuditService,
  ) {}

  /** Throws 409 if another product shares the same name (active or trashed) */
  private async assertUniqueProductName(
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const query: Record<string, unknown> = {
      name: new RegExp(`^${escaped}$`, 'i'),
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
    dto: CreateProductDto,
    imageUrl: string,
    actorId: string,
  ): Promise<ProductDocument> {
    await this.assertUniqueProductName(dto.name);
    const product = await this.productModel.create({
      ...dto,
      sectionId: new Types.ObjectId(dto.sectionId),
      imageUrl,
      remainingQuantity: dto.initialQuantity,
    });
    await this.auditService.log(product._id, AuditAction.CREATED, actorId, {
      name: dto.name,
      purchasePrice: dto.purchasePrice,
      salePrice: dto.salePrice,
      initialQuantity: dto.initialQuantity,
    });
    this.eventsGateway.emit('product:created', product);
    return product;
  }

  async findAll(sectionId?: string): Promise<ProductWithMetrics[]> {
    const filter: Record<string, unknown> = { deletedAt: null };
    if (sectionId) filter.sectionId = new Types.ObjectId(sectionId);
    const products = await this.productModel
      .find(filter)
      .sort({ createdAt: -1 })
      .exec();
    return products.map((p) => this.withMetrics(p));
  }

  async findOne(id: string): Promise<ProductDetail> {
    const product = await this.productModel.findById(id).exec();
    if (!product) throw new NotFoundException(`Product ${id} not found`);

    const sales = await this.saleModel
      .find({ productId: new Types.ObjectId(id) })
      .populate('sellerId', 'name email')
      .sort({ createdAt: -1 })
      .exec();

    const auditLogs = await this.auditService.findByProduct(id);

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
    id: string,
    dto: UpdateProductDto,
    actorId: string,
  ): Promise<ProductDocument> {
    const product = await this.productModel.findById(id).exec();
    if (!product) throw new NotFoundException(`Product ${id} not found`);

    const changes: Record<string, unknown> = {};

    if (dto.name && dto.name !== product.name) {
      changes.name = { from: product.name, to: dto.name };
      product.name = dto.name;
      await this.auditService.log(
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
        id,
        AuditAction.STOCK_CHANGED,
        actorId,
        stockChange,
      );
    }

    if (
      dto.newRemainingQuantity !== undefined &&
      dto.newRemainingQuantity !== product.remainingQuantity
    ) {
      await this.auditService.log(id, AuditAction.STOCK_CHANGED, actorId, {
        previousRemainingQuantity: product.remainingQuantity,
        newRemainingQuantity: dto.newRemainingQuantity,
      });
      product.remainingQuantity = dto.newRemainingQuantity;
    }

    if (dto.sectionId) {
      const newId = new Types.ObjectId(dto.sectionId);
      if (!product.sectionId.equals(newId)) {
        changes.sectionId = { from: product.sectionId, to: newId };
        product.sectionId = newId;
        await this.auditService.log(
          id,
          AuditAction.SECTION_CHANGED,
          actorId,
          changes,
        );
      }
    }

    const saved = await product.save();
    this.eventsGateway.emit('product:updated', saved);
    return saved;
  }

  async remove(id: string, actorId: string): Promise<ProductDocument> {
    const product = await this.productModel.findById(id).exec();
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    await this.auditService.log(id, AuditAction.DELETED, actorId, {
      name: product.name,
    });
    product.deletedAt = new Date();
    const saved = await product.save();
    this.eventsGateway.emit('product:deleted', id);
    return saved;
  }

  async findTrashed(): Promise<ProductDocument[]> {
    return this.productModel
      .find({ deletedAt: { $ne: null } })
      .sort({ deletedAt: -1 })
      .exec();
  }

  async restore(id: string): Promise<ProductDocument> {
    const product = await this.productModel
      .findByIdAndUpdate(id, { deletedAt: null }, { new: true })
      .exec();
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    this.eventsGateway.emit('product:created', product);
    return product;
  }

  async permanentDelete(id: string): Promise<ProductDocument> {
    const product = await this.productModel.findById(id).exec();
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    await this.s3Service.deleteFile(product.imageUrl);
    await product.deleteOne();
    return product;
  }

  /** Called by SalesService to decrement stock */
  async decrementStock(
    productId: string,
    quantity: number,
  ): Promise<ProductDocument> {
    const product = await this.productModel
      .findByIdAndUpdate(
        productId,
        { $inc: { remainingQuantity: -quantity } },
        { new: true },
      )
      .exec();
    if (!product) throw new NotFoundException(`Product ${productId} not found`);
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
