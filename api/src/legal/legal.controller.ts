import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedPrincipal } from '../auth/strategies/jwt.strategy';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import { NoStoreInterceptor } from '../subscriptions/payments/subscription-payments.controller';
import { LegalAcceptanceDto } from './dto/legal-acceptance.dto';
import { LegalAcceptanceService } from './legal-acceptance.service';

/**
 * 1-16C.2 — Confirmation des conditions par un compte EXISTANT.
 *
 * Gardes globaux inchangés : compte et version de session relus en base,
 * appartenance et commerce ACTIFS, accès commercial actif (une session
 * limitée n'y accède pas, et une acceptation ne lève aucune restriction).
 * Aucune permission requise : chaque membre confirme pour lui-même. Le rôle
 * (propriétaire ou non) vient du contexte relu par `OrganizationGuard`,
 * jamais du client. Aucune route métier ne dépend de cette acceptation :
 * ventes et synchronisation hors connexion restent inchangées.
 */
@Controller('legal')
@UseInterceptors(NoStoreInterceptor)
export class LegalController {
  constructor(private readonly legal: LegalAcceptanceService) {}

  @Get('acceptance')
  status(
    @CurrentUser() user: AuthenticatedPrincipal,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.legal.status(
      user._id.toString(),
      organizationContext.organizationId,
      organizationContext.role,
    );
  }

  @Post('acceptance')
  @HttpCode(200)
  confirm(
    @CurrentUser() user: AuthenticatedPrincipal,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
    @Body() dto: LegalAcceptanceDto,
  ) {
    return this.legal.confirm(
      user._id.toString(),
      organizationContext.organizationId,
      organizationContext.role,
      dto,
    );
  }
}
