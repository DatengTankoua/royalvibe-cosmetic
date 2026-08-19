import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type SaleDocument = HydratedDocument<Sale>;

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class Sale {
  @Prop({ required: true, type: Types.ObjectId, ref: 'Product' })
  productId: Types.ObjectId;

  // snapshot so the name survives permanent product deletion
  @Prop()
  productName?: string;

  @Prop({ required: true, min: 1 })
  quantity: number;

  @Prop({ required: true, min: 0 })
  salePrice: number;

  @Prop({ required: true, type: Types.ObjectId, ref: 'User' })
  sellerId: Types.ObjectId;

  @Prop({ trim: true })
  buyerName?: string;

  @Prop({ trim: true })
  buyerContact?: string;
}

export const SaleSchema = SchemaFactory.createForClass(Sale);
