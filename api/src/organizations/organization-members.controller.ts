import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
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
import { parsePermissionCatalog } from './permissions';
import { PushOutboxService } from '../push/push-outbox.service';
import {
  MemberActivityAction,
  MemberActivityEntity,
} from '../notifications/member-activity';

/**
 * Gestion des membres (1-7C) : `organizationId` provient EXCLUSIVEMENT du
 * contexte branché par `OrganizationGuard` — jamais du body/query/header.
 * L'anti-escalade et la relecture fraîche acteur/cible vivent dans
 * `OrganizationsService` (jamais dans ce contrôleur).
 */
@Controller('organizations/members')
export class OrganizationMembersController {
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly pushOutbox: PushOutboxService,
  ) {}

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
  async update(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: UpdateMembershipDto,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
    // 1-19A : catalogue de permissions connu du formulaire (absent : web
    // antérieur → permissions inconnues de lui conservées).
    @Query('permissionsCatalog') permissionsCatalog?: string,
  ) {
    const updated = await this.organizationsService.updateMembership(
      organizationContext.organizationId,
      organizationContext.userId,
      id,
      dto,
      parsePermissionCatalog(permissionsCatalog),
    );
    // 1-19A : rôle, permissions ou statut modifiés par un autre membre
    // que le propriétaire (le transfert de propriété lui est réservé).
    await this.pushOutbox.memberActivity(organizationContext, {
      entity: MemberActivityEntity.MEMBER,
      action: MemberActivityAction.UPDATED,
      targetId: updated.membershipId,
      targetName: updated.user.name,
    });
    return updated;
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
