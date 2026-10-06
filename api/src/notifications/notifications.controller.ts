import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import { NoStoreInterceptor } from '../subscriptions/payments/subscription-payments.controller';
import {
  ListNotificationsQueryDto,
  NotificationPreferencesDto,
  ReportUnsoldQueryDto,
} from './dto/notification.dto';
import {
  NotificationCenterService,
  NotificationReaderContext,
} from './notification-center.service';

const toContext = (
  context: ResolvedOrganizationContext,
): NotificationReaderContext => ({
  userId: context.userId,
  organizationId: context.organizationId,
  role: context.role,
  permissions: context.permissions,
});

/**
 * 1-16A.1 — Centre de notifications de l'utilisateur courant dans
 * l'organisation courante.
 *
 * Gardes globaux inchangés, SANS exception commerciale : JWT applicatif,
 * abonnement actif, membership et organisation actives. Utilisateur,
 * organisation, rôle et permissions : contexte serveur uniquement ; chaque
 * lecture revalide les catégories autorisées (aucun élargissement de droits).
 * Ouvrir la liste ne marque rien comme lu : seules `…/:id/open`,
 * `…/:id/read` et `read-all` le font.
 */
@Controller('notifications')
@UseInterceptors(NoStoreInterceptor)
export class NotificationsController {
  constructor(private readonly center: NotificationCenterService) {}

  @Get()
  list(
    @CurrentOrganization() context: ResolvedOrganizationContext,
    @Query() query: ListNotificationsQueryDto,
  ) {
    return this.center.list(toContext(context), {
      unreadOnly: query.status === 'unread',
      limit: query.limit ?? 20,
      before: query.before,
    });
  }

  @Get('unread-count')
  async unreadCount(
    @CurrentOrganization() context: ResolvedOrganizationContext,
  ) {
    return { count: await this.center.unreadCount(toContext(context)) };
  }

  @Get('preferences')
  preferences(@CurrentOrganization() context: ResolvedOrganizationContext) {
    return this.center.preferencesView(toContext(context));
  }

  @Put('preferences')
  updatePreferences(
    @CurrentOrganization() context: ResolvedOrganizationContext,
    @Body() dto: NotificationPreferencesDto,
  ) {
    return this.center.updatePreferences(toContext(context), dto);
  }

  @Post('read-all')
  @HttpCode(200)
  async readAll(@CurrentOrganization() context: ResolvedOrganizationContext) {
    return { marked: await this.center.readAll(toContext(context)) };
  }

  @Post(':id/open')
  @HttpCode(200)
  open(
    @CurrentOrganization() context: ResolvedOrganizationContext,
    @Param('id') id: string,
  ) {
    return this.center.open(toContext(context), id);
  }

  @Post(':id/read')
  @HttpCode(200)
  read(
    @CurrentOrganization() context: ResolvedOrganizationContext,
    @Param('id') id: string,
  ) {
    return this.center.markRead(toContext(context), id);
  }

  @Get(':id/report/unsold')
  reportUnsold(
    @CurrentOrganization() context: ResolvedOrganizationContext,
    @Param('id') id: string,
    @Query() query: ReportUnsoldQueryDto,
  ) {
    return this.center.reportUnsold(
      toContext(context),
      id,
      query.offset ?? 0,
      query.limit ?? 20,
    );
  }
}
