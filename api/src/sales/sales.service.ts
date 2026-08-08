import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Sale, SaleDocument } from './schemas/sale.schema';
import { CreateSaleDto } from './dto/create-sale.dto';
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
}
