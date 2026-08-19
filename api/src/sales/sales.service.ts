import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Sale, SaleDocument } from './schemas/sale.schema';
import { CreateSaleDto } from './dto/create-sale.dto';
import { UpdateSaleDto } from './dto/update-sale.dto';
import { ProductsService } from '../products/products.service';
import { EventsGateway } from '../events/events.gateway';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';

@Injectable()
export class SalesService {
  constructor(
    @InjectModel(Sale.name) private saleModel: Model<SaleDocument>,
    private productsService: ProductsService,
    private eventsGateway: EventsGateway,
    private auditService: AuditService,
  ) {}

  async create(dto: CreateSaleDto, sellerId: string): Promise<SaleDocument> {
    const { product } = await this.productsService.findOne(dto.productId);
    if (product.remainingQuantity < dto.quantity) {
      throw new BadRequestException(
        `Not enough stock. Available: ${product.remainingQuantity}`,
      );
    }

    const sale = await this.saleModel.create({
      ...dto,
      productId: new Types.ObjectId(dto.productId),
      productName: product.name,
      sellerId: new Types.ObjectId(sellerId),
    });

    await this.productsService.decrementStock(dto.productId, dto.quantity);

    await this.auditService.log(dto.productId, AuditAction.SOLD, sellerId, {
      saleId: sale._id,
      quantity: dto.quantity,
      salePrice: dto.salePrice,
      buyerName: dto.buyerName,
    });

    const populated = await sale.populate('sellerId', 'name email');
    this.eventsGateway.emit('sale:created', populated);
    return populated;
  }

  async findAll(productId?: string): Promise<SaleDocument[]> {
    const filter = productId
      ? { productId: new Types.ObjectId(productId) }
      : {};
    return this.saleModel
      .find(filter)
      .populate('sellerId', 'name email')
      .populate('productId', 'name')
      .sort({ createdAt: -1 })
      .exec();
  }

  async update(
    id: string,
    dto: UpdateSaleDto,
    actorId: string,
  ): Promise<SaleDocument> {
    const sale = await this.saleModel.findById(id).exec();
    if (!sale) throw new NotFoundException(`Sale ${id} not found`);

    const changes: Record<string, unknown> = {};

    if (dto.quantity !== undefined && dto.quantity !== sale.quantity) {
      // positive delta restores stock, negative consumes more
      const delta = sale.quantity - dto.quantity;
      await this.productsService.adjustStock(sale.productId.toString(), delta);
      changes.quantity = { from: sale.quantity, to: dto.quantity };
      sale.quantity = dto.quantity;
    }

    if (dto.salePrice !== undefined && dto.salePrice !== sale.salePrice) {
      changes.salePrice = { from: sale.salePrice, to: dto.salePrice };
      sale.salePrice = dto.salePrice;
    }

    const saved = await sale.save();
    try {
      await this.auditService.log(
        sale.productId.toString(),
        AuditAction.SALE_UPDATED,
        actorId,
        { saleId: id, ...changes },
      );
    } catch {
      // non-critical: do not fail the request if audit logging fails
    }
    return saved.populate('sellerId', 'name email');
  }

  async remove(id: string, actorId: string): Promise<void> {
    const sale = await this.saleModel.findById(id).exec();
    if (!sale) throw new NotFoundException(`Sale ${id} not found`);

    const productId = sale.productId.toString();
    const { quantity, salePrice } = sale;

    await this.productsService.adjustStock(productId, quantity);
    await sale.deleteOne();

    try {
      await this.auditService.log(
        productId,
        AuditAction.SALE_CANCELLED,
        actorId,
        { saleId: id, quantity, salePrice },
      );
    } catch {
      // non-critical: do not fail the request if audit logging fails
    }
  }
}
