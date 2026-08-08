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
    await this.auditModel.create({ productId, action, actorId, details });
  }

  async findByProduct(productId: string): Promise<AuditLogDocument[]> {
    return this.auditModel
      .find({ productId: new Types.ObjectId(productId) })
      .populate('actorId', 'name email role')
      .sort({ createdAt: -1 })
      .exec();
  }
}
