import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import type { ResolvedOrganizationContext } from './organizations.service';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { User } from '../users/schemas/user.schema';

/**
 * Invitations tenant-scopées (1-6B.1) : autorisation `members.invite`
 * (1-7B, `PermissionGuard` global) — plus d'exception `owner`, cette
 * permission est déjà déléguée par défaut à `admin` (§3 audit 1A).
 * `organizationId` provient exclusivement du contexte branché par
 * `OrganizationGuard` — jamais du body/query/header.
 */
@Controller('organizations/invitations')
@RequirePermissions('members.invite')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Post()
  create(
    @Body() dto: CreateInvitationDto,
    @CurrentUser() user: User,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.organizationsService.createInvitation(
      organizationContext.organizationId,
      user._id.toString(),
      dto,
    );
  }

  @Get()
  findAll(
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.organizationsService.listInvitations(
      organizationContext.organizationId,
    );
  }

  // 200 explicite : une révocation renvoie la vue résultante (le POST
  // par défaut NestJS répond 201 — trompeur pour une mutation d'état).
  @HttpCode(200)
  @Post(':id/revoke')
  revoke(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.organizationsService.revokeInvitation(
      organizationContext.organizationId,
      id,
    );
  }
}
