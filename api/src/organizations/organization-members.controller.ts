import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import type { ResolvedOrganizationContext } from './organizations.service';
import { UpdateMembershipDto } from './dto/update-membership.dto';
import {
  RequirePermissions,
  OwnerOnly,
} from '../auth/decorators/permissions.decorator';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';

/**
 * Gestion des membres (1-7C) : `organizationId` provient EXCLUSIVEMENT du
 * contexte branché par `OrganizationGuard` — jamais du body/query/header.
 * L'anti-escalade et la relecture fraîche acteur/cible vivent dans
 * `OrganizationsService` (jamais dans ce contrôleur).
 */
@Controller('organizations/members')
export class OrganizationMembersController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Get()
  @RequirePermissions('members.manage')
  findAll(
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.organizationsService.listMembers(
      organizationContext.organizationId,
    );
  }

  @Patch(':id')
  @RequirePermissions('members.manage')
  update(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: UpdateMembershipDto,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.organizationsService.updateMembership(
      organizationContext.organizationId,
      organizationContext.userId,
      id,
      dto,
    );
  }

  // 200 explicite : le POST par défaut NestJS répond 201, trompeur pour une
  // mutation d'état (même convention que la révocation d'invitation).
  @HttpCode(200)
  @Post(':id/transfer-ownership')
  @OwnerOnly('ownership.transfer')
  transferOwnership(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.organizationsService.transferOwnership(
      organizationContext.organizationId,
      organizationContext.userId,
      id,
    );
  }
}
