import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';

import {
  AuditLog,
  AuditAction,
  AuditLogDocument,
} from './schemas/audit-log.schema';

// Session transactionnelle Mongoose — le type est dérivé de
// `Connection.startSession` car le driver `mongodb` n'est pas résolvable
// directement depuis ce workspace pnpm (pas de dépendance directe) ; on garde
// ainsi le type exact `ClientSession` sans import de dépendance.
type MongooseSession = Awaited<ReturnType<Connection['startSession']>>;

@Injectable()
export class AuditService {
  constructor(
    @InjectModel(AuditLog.name) private auditModel: Model<AuditLogDocument>,
  ) {}

  /**
   * Journalise une entrée d'audit — l'organisation est OBLIGATOIRE
   * (1-4C.1) : elle est écrite dans le document et jamais déduite.
   * Quand une `session` transactionnelle est fournie, l'écriture est associée
   * à cette session : elle est donc validée ou annulée (rollback) avec le
   * reste de la transaction de la vente. Sans session, le comportement est
   * inchangé (écriture autonome).
   */
  async log(
    organizationId: string,
    productId: string | Types.ObjectId,
    action: AuditAction,
    actorId: string | Types.ObjectId,
    details: Record<string, unknown> = {},
    session?: MongooseSession,
  ): Promise<void> {
    // `create([doc], { session })` : seul overload officiellement supporté
    // de `Model.create` acceptant des options (dont la session) est la charge
    // en tableau — cf. types Mongoose `create(doc)` sans option.
    await this.auditModel.create(
      [
        {
          organizationId: new Types.ObjectId(organizationId),
          productId: new Types.ObjectId(productId.toString()),
          action,
          actorId: new Types.ObjectId(actorId.toString()),
          details,
        },
      ],
      { session: session ?? null },
    );
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
