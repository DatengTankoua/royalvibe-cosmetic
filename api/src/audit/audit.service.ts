import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  AuditLog,
  AuditAction,
  AuditLogDocument,
} from './schemas/audit-log.schema';

@Injectable()
export class AuditService {
  constructor(
    @InjectModel(AuditLog.name) private auditModel: Model<AuditLogDocument>,
  ) {}

  async log(
    productId: string | Types.ObjectId,
    action: AuditAction,
    actorId: string | Types.ObjectId,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await this.auditModel.create({
      productId: new Types.ObjectId(productId.toString()),
      action,
      actorId: new Types.ObjectId(actorId.toString()),
      details,
    });
  }

  async findByProduct(productId: string): Promise<AuditLogDocument[]> {
    const oid = new Types.ObjectId(productId);
    return this.auditModel
      .find({ $or: [{ productId: oid }, { productId: productId }] })
      .populate('actorId', 'name email role')
      .sort({ createdAt: -1 })
      .exec();
  }
}
