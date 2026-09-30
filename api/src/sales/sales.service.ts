import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { Sale, SaleDocument } from './schemas/sale.schema';
import {
  SaleOperation,
  SaleOperationDocument,
} from './schemas/sale-operation.schema';
import { CreateSaleDto } from './dto/create-sale.dto';
import { SALE_ERROR_CODES } from './sale-error-codes';
import {
  NormalizedSaleInput,
  computeSaleRequestHash,
  isSaleOperationDuplicateKeyError,
  normalizeCreateSale,
  resolveOccurredAt,
} from './sale-idempotency';
import { UpdateSaleDto } from './dto/update-sale.dto';
import { ProductsService } from '../products/products.service';
import { EventsGateway } from '../events/events.gateway';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    @InjectModel(Sale.name) private saleModel: Model<SaleDocument>,
    @InjectModel(SaleOperation.name)
    private saleOperationModel: Model<SaleOperationDocument>,
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
   *
   * 1-11C.1 — IDEMPOTENCE : avec `clientOperationId`, une trace
   * `SaleOperation` (index unique `{organizationId, clientOperationId}`) est
   * la première écriture de la même transaction. Tout rejeu (séquentiel ou
   * concurrent) renvoie la même vente sans stock, audit ni événement
   * (`replay`). Sans clé : flux historique.
   */
  async create(
    organizationId: string,
    dto: CreateSaleDto,
    sellerId: string,
  ): Promise<SaleDocument> {
    const input = normalizeCreateSale(dto);
    if (dto.clientOperationId === undefined) {
      // Flux historique : aucune déduplication.
      return this.createFresh(
        organizationId,
        input,
        sellerId,
        resolveOccurredAt(input.occurredAt),
      );
    }

    // 1-11C.1 — flux idempotent.
    const clientOperationId = dto.clientOperationId;
    const requestHash = computeSaleRequestHash(input);
    const key = {
      organizationId: new Types.ObjectId(organizationId),
      clientOperationId,
    };

    // Chemin rapide : clé déjà appliquée → réponse rejouée, AVANT toute
    // validation de plage de date (un rejeu tardif d'une vente appliquée
    // doit toujours aboutir au même résultat).
    const existing = await this.saleOperationModel.findOne(key).exec();
    if (existing) {
      return this.replay(organizationId, existing, sellerId, requestHash);
    }

    const occurredAt = resolveOccurredAt(input.occurredAt);
    try {
      return await this.createFresh(
        organizationId,
        input,
        sellerId,
        occurredAt,
        { clientOperationId, requestHash },
      );
    } catch (error) {
      // Rejeu concurrent : l'autre requête a commité la même clé. Seul
      // l'E11000 de l'index idempotent est absorbé ; tout autre est relancé.
      if (!isSaleOperationDuplicateKeyError(error)) throw error;
      const winner = await this.saleOperationModel
        .findOne(key)
        .read('primary')
        .exec();
      if (!winner) throw error;
      return this.replay(organizationId, winner, sellerId, requestHash);
    }
  }

  /**
   * Rejeu d'une clé déjà appliquée : AUCUNE écriture, AUCUN stock, AUCUN
   * audit, AUCUN événement. Contrôles dans cet ordre :
   * 1. autre vendeur → 409 `IDEMPOTENCY_KEY_CONFLICT`, sans aucune donnée ;
   * 2. payload différent → 409 `IDEMPOTENCY_KEY_REUSED` ;
   * 3. vente supprimée depuis → 409 `SALE_OPERATION_ALREADY_APPLIED` ;
   * 4. sinon → la vente (même `_id`), dans sa représentation COURANTE
   *    (modifications PATCH ultérieures incluses), vendeur peuplé comme la
   *    réponse initiale. Statut HTTP 201 inchangé.
   */
  private async replay(
    organizationId: string,
    operation: SaleOperationDocument,
    sellerId: string,
    requestHash: string,
  ): Promise<SaleDocument> {
    if (operation.sellerId.toString() !== sellerId) {
      throw new ConflictException({
        code: SALE_ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT,
        message: "Clé d'opération déjà utilisée.",
      });
    }
    if (operation.requestHash !== requestHash) {
      throw new ConflictException({
        code: SALE_ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
        message: "Clé d'opération déjà utilisée pour une autre vente.",
      });
    }
    const sale = await this.saleModel
      .findOne({
        _id: operation.saleId,
        organizationId: new Types.ObjectId(organizationId),
      })
      .populate('sellerId', 'name email')
      .exec();
    if (!sale) {
      throw new ConflictException({
        code: SALE_ERROR_CODES.SALE_OPERATION_ALREADY_APPLIED,
        message: 'Vente déjà enregistrée puis supprimée.',
      });
    }
    return sale;
  }

  private async createFresh(
    organizationId: string,
    input: NormalizedSaleInput,
    sellerId: string,
    occurredAt: Date,
    idempotency?: { clientOperationId: string; requestHash: string },
  ): Promise<SaleDocument> {
    const orgOid = new Types.ObjectId(organizationId);
    // `_id` connu AVANT la transaction : la trace idempotente le référence
    // dès sa première écriture.
    const saleId = new Types.ObjectId();
    const session = await this.connection.startSession();
    let created: SaleDocument | undefined;

    try {
      await session.withTransaction(async () => {
        // 0. (1-11C.1) Trace idempotente en PREMIÈRE écriture : un rejeu
        //    concurrent de la même clé bute sur l'index unique (conflit
        //    d'écriture puis E11000). Annulée avec le reste sur rollback.
        if (idempotency) {
          await this.saleOperationModel.create(
            [
              {
                organizationId: orgOid,
                clientOperationId: idempotency.clientOperationId,
                sellerId: new Types.ObjectId(sellerId),
                saleId,
                requestHash: idempotency.requestHash,
              },
            ],
            { session },
          );
        }

        // 1. Décrémentation ATOMIQUE et conditionnelle du stock tenant. Lève
        //    404 (produit absent/étranger/corbeillé) ou 400 (stock
        //    insuffisant) : la transaction est alors annulée, rien n'est
        //    persisté.
        const product = await this.productsService.decrementStock(
          organizationId,
          input.productId,
          input.quantity,
          session,
        );

        // 2. Création de la vente, MÊME session. L'org SERVEUR est écrite
        //    dans le document (jamais issue du DTO). Sur échec, le rollback
        //    annule la décrémentation du stock (point 1).
        const [sale] = await this.saleModel.create(
          [
            {
              ...(idempotency ? { _id: saleId } : {}),
              organizationId: orgOid,
              productId: new Types.ObjectId(input.productId),
              quantity: input.quantity,
              salePrice: input.salePrice,
              sellerId: new Types.ObjectId(sellerId),
              productName: product.name,
              occurredAt,
              ...(input.buyerName !== null
                ? { buyerName: input.buyerName }
                : {}),
              ...(input.buyerContact !== null
                ? { buyerContact: input.buyerContact }
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
          input.productId,
          AuditAction.SOLD,
          sellerId,
          {
            saleId: sale._id,
            quantity: input.quantity,
            salePrice: input.salePrice,
            buyerName: input.buyerName ?? undefined,
            ...(idempotency
              ? { clientOperationId: idempotency.clientOperationId }
              : {}),
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
    // Best effort, UNE fois dans le flux normal : la vente est déjà commitée,
    // un échec d'émission ne doit pas la transformer en erreur (un rejeu
    // n'émettrait de toute façon plus rien). Aucune garantie « exactement
    // une émission » en cas de crash entre le commit et cette ligne.
    try {
      // 1-12H — diffusion commune à toute l'organisation : identifiants
      // seuls, jamais la vente d'un collègue (prix, vendeur, acheteur,
      // coordonnées). Un client intéressé recharge via l'API autorisée.
      this.eventsGateway.emitToOrganization(organizationId, 'sale:created', {
        _id: String(populated._id),
        productId: String(populated.productId),
      });
    } catch {
      this.logger.warn('sale:created non émis (best effort).');
    }
    return populated;
  }

  async findAll(
    organizationId: string,
    productId?: string,
    scopeSellerId?: string,
  ): Promise<SaleDocument[]> {
    const filter: Record<string, Types.ObjectId> = {
      organizationId: new Types.ObjectId(organizationId),
    };
    if (productId) filter.productId = new Types.ObjectId(productId);
    // 1-7B — scope `sales.view_own` : restreint au vendeur courant.
    if (scopeSellerId) filter.sellerId = new Types.ObjectId(scopeSellerId);
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
    scopeSellerId?: string,
  ): Promise<SaleDocument> {
    const session = await this.connection.startSession();
    let saved: SaleDocument | undefined;
    try {
      await session.withTransaction(async () => {
        const filter: Record<string, Types.ObjectId> = {
          _id: new Types.ObjectId(id),
          organizationId: new Types.ObjectId(organizationId),
        };
        // 1-7B — sans `sales.view_all` : une vente d'un autre vendeur est
        // indistinguable d'une vente absente (même 404, aucune fuite).
        if (scopeSellerId) filter.sellerId = new Types.ObjectId(scopeSellerId);
        const sale = await this.saleModel
          .findOne(filter, null, { session })
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
    // 1-12H (correctif) — APRÈS le commit : invalidation minimale pour
    // rafraîchir stock et agrégats chez les autres membres (rechargement via
    // l'API, qui applique leurs permissions).
    this.emitSaleInvalidation(organizationId, 'sale:updated', {
      _id: id,
      productId: String(saved.productId),
    });
    return saved.populate('sellerId', 'name email');
  }

  /**
   * 1-12H — diffusion commune à toute l'organisation : identifiants seuls,
   * jamais le prix, le vendeur, l'acheteur ni ses coordonnées. Best effort :
   * une panne d'émission ne transforme jamais une mutation commitée en
   * erreur.
   */
  private emitSaleInvalidation(
    organizationId: string,
    event: 'sale:updated' | 'sale:deleted',
    payload: { _id: string; productId: string },
  ): void {
    try {
      this.eventsGateway.emitToOrganization(organizationId, event, payload);
    } catch {
      this.logger.warn(`${event} non émis (best effort).`);
    }
  }

  async remove(
    organizationId: string,
    id: string,
    actorId: string,
    scopeSellerId?: string,
  ): Promise<void> {
    const session = await this.connection.startSession();
    let removedProductId: string | undefined;
    try {
      await session.withTransaction(async () => {
        const filter: Record<string, Types.ObjectId> = {
          _id: new Types.ObjectId(id),
          organizationId: new Types.ObjectId(organizationId),
        };
        if (scopeSellerId) filter.sellerId = new Types.ObjectId(scopeSellerId);
        const sale = await this.saleModel
          .findOne(filter, null, { session })
          .exec();
        if (!sale) throw new NotFoundException(`Sale ${id} not found`);

        const productId = sale.productId.toString();
        removedProductId = productId;
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
    // Après le commit uniquement (un rollback lève avant d'arriver ici).
    if (removedProductId) {
      this.emitSaleInvalidation(organizationId, 'sale:deleted', {
        _id: id,
        productId: removedProductId,
      });
    }
  }
}
