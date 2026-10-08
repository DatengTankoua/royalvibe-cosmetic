import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { SKIP_PAYMENT_THROTTLERS } from '../common/subscription-payment-rate-limiting';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import { NoStoreInterceptor } from '../subscriptions/payments/subscription-payments.controller';
import { CreateSupportRequestDto } from './dto/create-support-request.dto';
import { SupportRequestThrottlerGuard } from './support-rate-limiting';
import { SupportService } from './support.service';

/**
 * 1-16C.1 — Assistance depuis l'organisation COURANTE.
 *
 * Gardes globaux, dans l'ordre : session et version du compte relues en
 * base (`JwtAuthGuard`), appartenance et organisation ACTIVES relues à
 * chaque requête (`OrganizationGuard`), accès commercial (abonnement actif ;
 * une session limitée n'y accède jamais), puis permission
 * `support.contact` calculée sur les droits ACTUELS en base
 * (`PermissionGuard`) : un droit retiré s'applique à la requête suivante,
 * quel que soit l'état du navigateur ou du JWT.
 */
@Controller('support')
@RequirePermissions('support.contact')
@UseInterceptors(NoStoreInterceptor)
export class SupportController {
  constructor(private readonly support: SupportService) {}

  /** Informations qui seront jointes, affichées avant l'envoi. */
  @Get('context')
  context(
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.support.getContext(organizationContext);
  }

  @Post('requests')
  @HttpCode(201)
  @UseGuards(SupportRequestThrottlerGuard)
  @SkipThrottle({
    'login-short': true,
    'login-long': true,
    'invitation-create': true,
    ...SKIP_PAYMENT_THROTTLERS,
  })
  submit(
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
    @Body() dto: CreateSupportRequestDto,
  ) {
    return this.support.submit(organizationContext, dto);
  }
}
