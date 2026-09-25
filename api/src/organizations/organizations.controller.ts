import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import type { ResolvedOrganizationContext } from './organizations.service';
import { OrganizationRole } from './permissions';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { User } from '../users/schemas/user.schema';

/**
 * Invitations tenant-scopées (1-6B.1) : autorisation TEMPORAIRE
 * `context.role === owner` uniquement (le `PermissionGuard` générique
 * arrive en 1-7). `organizationId` provient exclusivement du contexte
 * branché par `OrganizationGuard` — jamais du body/query/header.
 */
@Controller('organizations/invitations')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  private assertOwner(context: ResolvedOrganizationContext): void {
    if (context.role !== OrganizationRole.OWNER) {
      throw new ForbiddenException({
        code: 'OWNER_ONLY',
        message:
          "Seul le propriétaire de l'organisation peut gérer les invitations.",
      });
    }
  }

  @Post()
  create(
    @Body() dto: CreateInvitationDto,
    @CurrentUser() user: User,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    this.assertOwner(organizationContext);
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
    this.assertOwner(organizationContext);
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
    this.assertOwner(organizationContext);
    return this.organizationsService.revokeInvitation(
      organizationContext.organizationId,
      id,
    );
  }
}
