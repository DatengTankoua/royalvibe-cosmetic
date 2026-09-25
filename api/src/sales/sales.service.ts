import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';
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
    @InjectConnection() private connection: Connection,
    private productsService: ProductsService,
    private eventsGateway: EventsGateway,
    private auditService: AuditService,
  ) {}

  /**
   * Création d'une vente — TRANSACTION ATOMIQUE (phase 0B.7B).
   *
   * Les trois écritures déterminant l'état métier (décrémentation du stock,
   * création de la vente, journal d'audit `SOLD`) sont groupées dans UNE
   * seule transaction MongoDB : elles sont soit toutes validées (commit),
   * soit toutes annulées (rollback). La même instance `ClientSession` est
   * transmise explicitement à chaque lecture/écriture.
   *
   * Garanties :
   * - aucune vente sans stock décrémenté, aucun stock décrémenté sans vente ;
   * - stock jamais négatif (garde `remainingQuantity >= quantity` atomique) ;
   * - aucun audit `SOLD` orphelin (annulée avec la vente) ;
   * - l'événement Socket.IO `sale:created` part UNIQUEMENT après le commit.
   *
   * Aucune opération parallèle (Promise.all) à l'intérieur : l'audit référence
   * le `saleId` de la vente créée et Mongoose exige la session explicite sur
   * chaque opération.
   *
   * 1-4C.1 — TENANT : `organizationId` (celle du vendeur, branchée par
   * `OrganizationGuard` sur `request`) est le 1er argument OBLIGATOIRE. Ce
   * tenant est écrit dans la vente, passé à la décrémentation ATOMIQUE du
   * stock ET à l'audit `SOLD` — les trois écritures de la transaction. Le
   * DTO ne le porte jamais et ne le détermine pas.
   */
  async create(
    organizationId: string,
    dto: CreateSaleDto,
    sellerId: string,
  ): Promise<SaleDocument> {
    const orgOid = new Types.ObjectId(organizationId);
    const session = await this.connection.startSession();
    let created: SaleDocument | undefined;

    try {
      await session.withTransaction(async () => {
        // 1. Décrémentation ATOMIQUE et conditionnelle du stock tenant. Lève
        //    404 (produit absent/étranger/corbeillé) ou 400 (stock
        //    insuffisant) : la transaction est alors annulée, rien n'est
        //    persisté.
        const product = await this.productsService.decrementStock(
          organizationId,
          dto.productId,
          dto.quantity,
          session,
        );

        // 2. Création de la vente, MÊME session. L'org SERVEUR est écrite
        //    dans le document (jamais issue du DTO). Sur échec, le rollback
        //    annule la décrémentation du stock (point 1).
        const [sale] = await this.saleModel.create(
          [
            {
              organizationId: orgOid,
              productId: new Types.ObjectId(dto.productId),
              quantity: dto.quantity,
              salePrice: dto.salePrice,
              sellerId: new Types.ObjectId(sellerId),
              productName: product.name,
              ...(dto.buyerName !== undefined
                ? { buyerName: dto.buyerName }
                : {}),
              ...(dto.buyerContact !== undefined
                ? { buyerContact: dto.buyerContact }
                : {}),
            },
          ],
          { session },
        );

        // 3. Journal d'audit `SOLD` référençant la VENTE créée dans cette
        //    même tentative — MÊME session, MÊME org : si la vente est
        //    annulée, l'audit ne subsiste pas.
        await this.auditService.log(
          organizationId,
          dto.productId,
          AuditAction.SOLD,
          sellerId,
          {
            saleId: sale._id,
            quantity: dto.quantity,
            salePrice: dto.salePrice,
            buyerName: dto.buyerName,
          },
          session,
        );

        created = sale;
      });
    } finally {
      // Session fermée dans TOUS les cas (succès ou erreur) — pas de fuite.
      await session.endSession();
    }

    // APRÈS le commit uniquement : peupler le vendeur puis émettre l'événement
    // temps réel. Un rollback ne produit donc AUCUN événement Socket.IO.
    if (!created) {
      throw new Error('Sale transaction completed without creating a sale');
    }
    // Détache explicitement le document de la session (déjà fermée) avant tout
    // usage ultérieur (populate, sérialisation) — plus aucune opération liée
    // à la session close.
    created.$session(null);
    const populated = await created.populate('sellerId', 'name email');
    this.eventsGateway.emitToOrganization(
      organizationId,
      'sale:created',
      populated,
    );
    return populated;
  }

  async findAll(
    organizationId: string,
    productId?: string,
  ): Promise<SaleDocument[]> {
    const filter: Record<string, Types.ObjectId> = {
      organizationId: new Types.ObjectId(organizationId),
    };
    if (productId) filter.productId = new Types.ObjectId(productId);
    return this.saleModel
      .find(filter)
      .populate('sellerId', 'name email')
      .populate('productId', 'name')
      .sort({ createdAt: -1 })
      .exec();
  }

  async update(
    organizationId: string,
    id: string,
    dto: UpdateSaleDto,
    actorId: string,
  ): Promise<SaleDocument> {
    const session = await this.connection.startSession();
    let saved: SaleDocument | undefined;
    try {
      await session.withTransaction(async () => {
        const sale = await this.saleModel
          .findOne(
            {
              _id: new Types.ObjectId(id),
              organizationId: new Types.ObjectId(organizationId),
            },
            null,
            { session },
          )
          .exec();
        if (!sale) throw new NotFoundException(`Sale ${id} not found`);

        const changes: Record<string, unknown> = {};
        if (dto.quantity !== undefined && dto.quantity !== sale.quantity) {
          const delta = sale.quantity - dto.quantity;
          await this.productsService.adjustStock(
            organizationId,
            sale.productId.toString(),
            delta,
            session,
          );
          changes.quantity = { from: sale.quantity, to: dto.quantity };
          sale.quantity = dto.quantity;
        }
        if (dto.salePrice !== undefined && dto.salePrice !== sale.salePrice) {
          changes.salePrice = { from: sale.salePrice, to: dto.salePrice };
          sale.salePrice = dto.salePrice;
        }

        saved = await sale.save({ session });
        await this.auditService.log(
          organizationId,
          sale.productId.toString(),
          AuditAction.SALE_UPDATED,
          actorId,
          { saleId: id, ...changes },
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    if (!saved) {
      throw new Error('Sale transaction completed without updating a sale');
    }
    saved.$session(null);
    return saved.populate('sellerId', 'name email');
  }

  async remove(
    organizationId: string,
    id: string,
    actorId: string,
  ): Promise<void> {
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const sale = await this.saleModel
          .findOne(
            {
              _id: new Types.ObjectId(id),
              organizationId: new Types.ObjectId(organizationId),
            },
            null,
            { session },
          )
          .exec();
        if (!sale) throw new NotFoundException(`Sale ${id} not found`);

        const productId = sale.productId.toString();
        const { quantity, salePrice } = sale;
        await this.productsService.adjustStock(
          organizationId,
          productId,
          quantity,
          session,
        );
        await sale.deleteOne({ session });
        await this.auditService.log(
          organizationId,
          productId,
          AuditAction.SALE_CANCELLED,
          actorId,
          { saleId: id, quantity, salePrice },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
  }
}
