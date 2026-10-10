import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { SalesService } from './sales.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { UpdateSaleDto } from './dto/update-sale.dto';
import { SalesHistoryQueryDto } from './dto/sales-history-query.dto';
import { SALES_HISTORY_DEFAULT_LIMIT } from './sale-history';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { User } from '../users/schemas/user.schema';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import {
  hasPermission,
  PERMISSION_DENIED_RESPONSE,
} from '../organizations/permissions';
import {
  AllowInactiveSubscription,
  CurrentSubscriptionAccess,
} from '../subscriptions/subscription-access';
import type { SubscriptionAccessDecision } from '../subscriptions/subscription-access';
import { PushOutboxService } from '../push/push-outbox.service';
import {
  MemberActivityAction,
  MemberActivityEntity,
} from '../notifications/member-activity';

@Controller('sales')
export class SalesController {
  constructor(
    private readonly salesService: SalesService,
    private readonly pushOutbox: PushOutboxService,
  ) {}

  /**
   * 1-19A : modification et annulation RÉUSSIES annoncées au propriétaire
   * (best effort, après le service). La création a sa propre notification
   * (`sale-created`) : jamais annoncée en double ici.
   */
  private activity(
    context: ResolvedOrganizationContext,
    action: MemberActivityAction,
    saleId: string,
    productName: string | null | undefined,
    uniqueKey?: string,
  ): Promise<void> {
    return this.pushOutbox.memberActivity(context, {
      entity: MemberActivityEntity.SALE,
      action,
      targetId: saleId,
      targetName: productName ?? null,
      uniqueKey,
    });
  }

  // 1-14C.1 : exception `sale-replay` — JWT applicatif, membership et
  // `sales.record` toujours exigés. Abonnement inactif : seule la
  // confirmation d'une opération DÉJÀ appliquée est possible (aucune
  // écriture) ; toute nouvelle vente → 403 `SUBSCRIPTION_INACTIVE`.
  @Post()
  @AllowInactiveSubscription('sale-replay')
  @RequirePermissions('sales.record')
  create(
    @Body() dto: CreateSaleDto,
    @CurrentUser() user: User,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
    @CurrentSubscriptionAccess() access: SubscriptionAccessDecision | undefined,
  ) {
    return this.salesService.create(
      organizationContext.organizationId,
      dto,
      user._id.toString(),
      // Fail-closed : sans décision du guard, aucune nouvelle écriture.
      { newWritesAllowed: access?.active === true },
    );
  }

  // 1-7B — pas de métadonnée unique possible (OU entre deux permissions
  // au scope différent) : la décision de scope est prise ici, pas par
  // `PermissionGuard`.
  @Get()
  findAll(
    @Query('productId') productId: string | undefined,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    if (hasPermission(organizationContext, 'sales.view_all')) {
      return this.salesService.findAll(
        organizationContext.organizationId,
        productId,
      );
    }
    if (hasPermission(organizationContext, 'sales.view_own')) {
      return this.salesService.findAll(
        organizationContext.organizationId,
        productId,
        organizationContext.userId,
      );
    }
    throw new ForbiddenException(PERMISSION_DENIED_RESPONSE);
  }

  /**
   * 1-20E — Historique PAGINÉ (contrat explicite, à côté de `GET /sales`
   * conservé tel quel pour les anciens clients). Mêmes permissions et même
   * périmètre que `findAll` : `view_all` → toute l'organisation, `view_own`
   * → ventes du demandeur seulement (pages ET total), 403 sinon.
   * Réponse : `{ items, total, nextCursor }` (`nextCursor` null en fin).
   */
  @Get('history')
  findHistory(
    @Query() query: SalesHistoryQueryDto,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    const options = {
      limit: query.limit ?? SALES_HISTORY_DEFAULT_LIMIT,
      cursor: query.cursor,
      productId: query.productId,
    };
    if (hasPermission(organizationContext, 'sales.view_all')) {
      return this.salesService.findHistoryPage(
        organizationContext.organizationId,
        options,
      );
    }
    if (hasPermission(organizationContext, 'sales.view_own')) {
      return this.salesService.findHistoryPage(
        organizationContext.organizationId,
        options,
        organizationContext.userId,
      );
    }
    throw new ForbiddenException(PERMISSION_DENIED_RESPONSE);
  }

  @Patch(':id')
  @RequirePermissions('sales.record')
  async update(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: UpdateSaleDto,
    @CurrentUser() user: User,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    const actorId = user._id.toString();
    // sans `sales.view_all` : uniquement ses propres ventes (404 sinon,
    // indistinguable d'une vente absente — jamais de fuite d'existence).
    const updated = hasPermission(organizationContext, 'sales.view_all')
      ? await this.salesService.update(
          organizationContext.organizationId,
          id,
          dto,
          actorId,
        )
      : await this.salesService.update(
          organizationContext.organizationId,
          id,
          dto,
          actorId,
          organizationContext.userId,
        );
    await this.activity(
      organizationContext,
      MemberActivityAction.UPDATED,
      id,
      updated.productName ?? updated.lastKnownProductName,
    );
    return updated;
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('sales.record')
  async remove(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: User,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ): Promise<void> {
    const actorId = user._id.toString();
    const removed = hasPermission(organizationContext, 'sales.view_all')
      ? await this.salesService.remove(
          organizationContext.organizationId,
          id,
          actorId,
        )
      : await this.salesService.remove(
          organizationContext.organizationId,
          id,
          actorId,
          organizationContext.userId,
        );
    // Une vente n'est annulée qu'une fois : clé stable.
    await this.activity(
      organizationContext,
      MemberActivityAction.CANCELLED,
      id,
      removed.productName,
      id,
    );
  }
}
