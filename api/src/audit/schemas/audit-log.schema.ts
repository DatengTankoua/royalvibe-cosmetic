import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type AuditLogDocument = HydratedDocument<AuditLog>;

export enum AuditAction {
  CREATED = 'created',
  SOLD = 'sold',
  PRICE_CHANGED = 'price_changed',
  STOCK_CHANGED = 'stock_changed',
  NAME_CHANGED = 'name_changed',
  SECTION_CHANGED = 'section_changed',
  DELETED = 'deleted',
  SALE_UPDATED = 'sale_updated',
  SALE_CANCELLED = 'sale_cancelled',
}

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class AuditLog {
  @Prop({ required: true, type: Types.ObjectId, ref: 'Product' })
  productId: Types.ObjectId;

  @Prop({ required: true, enum: Object.values(AuditAction) })
  action: AuditAction;

  @Prop({ required: true, type: Types.ObjectId, ref: 'User' })
  actorId: Types.ObjectId;

  @Prop({ type: Object, default: {} })
  details: Record<string, unknown>;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
