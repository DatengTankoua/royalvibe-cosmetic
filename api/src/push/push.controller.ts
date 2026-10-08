import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import { AllowInactiveSubscription } from '../subscriptions/subscription-access';
import { NoStoreInterceptor } from '../subscriptions/payments/subscription-payments.controller';
import {
  PushEndpointDto,
  RegisterPushSubscriptionDto,
  UpdatePushPreferencesDto,
} from './dto/push-subscription.dto';
import {
  PushMemberContext,
  PushSubscriptionsService,
} from './push-subscriptions.service';

const toContext = (
  context: ResolvedOrganizationContext,
): PushMemberContext => ({
  userId: context.userId,
  organizationId: context.organizationId,
  role: context.role,
  permissions: context.permissions,
});

/**
 * 1-16A — Notifications push de l'appareil courant.
 *
 * Gardes globaux inchangés : JWT, e-mail vérifié, version de session,
 * membership active et organisation active (`OrganizationGuard`), JWT
 * applicatif et abonnement actif (`SubscriptionAccessGuard`). Utilisateur,
 * organisation, rôle et permissions : contexte SERVEUR uniquement.
 *
 * Seule exception commerciale : `POST …/subscription/remove`
 * (`identity`) — le retrait de l'appareil reste possible à la déconnexion
 * d'une session limitée ou d'une organisation dont l'abonnement a expiré ;
 * il ne fait que supprimer l'abonnement de l'utilisateur courant.
 *
 * Aucune réponse ne contient d'endpoint ni de clé.
 */
@Controller('notifications/push')
@UseInterceptors(NoStoreInterceptor)
export class PushController {
  constructor(private readonly subscriptions: PushSubscriptionsService) {}

  @Get('config')
  config(@CurrentOrganization() context: ResolvedOrganizationContext) {
    return this.subscriptions.config(toContext(context));
  }

  @Post('subscription')
  @HttpCode(200)
  register(
    @CurrentOrganization() context: ResolvedOrganizationContext,
    @Body() dto: RegisterPushSubscriptionDto,
  ) {
    return this.subscriptions.register(toContext(context), dto);
  }

  @Post('subscription/status')
  @HttpCode(200)
  status(
    @CurrentOrganization() context: ResolvedOrganizationContext,
    @Body() dto: PushEndpointDto,
  ) {
    return this.subscriptions.status(toContext(context), dto.endpoint);
  }

  @Patch('subscription')
  updatePreferences(
    @CurrentOrganization() context: ResolvedOrganizationContext,
    @Body() dto: UpdatePushPreferencesDto,
  ) {
    return this.subscriptions.updatePreferences(
      toContext(context),
      dto.endpoint,
      dto.preferences,
    );
  }

  @Post('subscription/remove')
  @HttpCode(204)
  @AllowInactiveSubscription('identity')
  async remove(
    @CurrentOrganization() context: ResolvedOrganizationContext,
    @Body() dto: PushEndpointDto,
  ): Promise<void> {
    await this.subscriptions.remove(context.userId, dto.endpoint);
  }
}
