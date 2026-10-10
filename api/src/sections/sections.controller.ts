import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { SectionsService } from './sections.service';
import { CreateSectionDto } from './dto/create-section.dto';
import { UpdateSectionDto } from './dto/update-section.dto';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { PushOutboxService } from '../push/push-outbox.service';
import {
  MemberActivityAction,
  MemberActivityEntity,
} from '../notifications/member-activity';

/**
 * Tenant = `organizationContext.organizationId` (branché par la garde,
 * jamais fourni par la requête) : c'est la source unique passée au service.
 *
 * 1-19A : écritures réussies d'un membre autre que le propriétaire annoncées
 * au propriétaire (best effort, après le service). Nom de section figé.
 */
@Controller('sections')
export class SectionsController {
  constructor(
    private readonly sectionsService: SectionsService,
    private readonly pushOutbox: PushOutboxService,
  ) {}

  private async activity<T extends { _id: unknown; name?: string | null }>(
    context: ResolvedOrganizationContext,
    action: MemberActivityAction,
    section: T,
    uniqueKey?: string,
  ): Promise<T> {
    await this.pushOutbox.memberActivity(context, {
      entity: MemberActivityEntity.SECTION,
      action,
      targetId: String(section._id),
      targetName: section.name ?? null,
      uniqueKey,
    });
    return section;
  }

  @Post()
  @RequirePermissions('catalog.manage')
  async create(
    @Body() dto: CreateSectionDto,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.activity(
      organizationContext,
      MemberActivityAction.CREATED,
      await this.sectionsService.create(
        organizationContext.organizationId,
        dto,
      ),
    );
  }

  @Get()
  findAll(
    // `= undefined` (et non `?`) : un paramètre optionnel ne peut précéder un
    // paramètre requis (TS1016) tandis que le contexte suit.
    @Query('parentId') parentId = undefined,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.sectionsService.findAll(
      organizationContext.organizationId,
      parentId,
    );
  }

  @Get(':id')
  findOne(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.sectionsService.findOne(organizationContext.organizationId, id);
  }

  @Patch(':id')
  @RequirePermissions('catalog.manage')
  async update(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: UpdateSectionDto,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.activity(
      organizationContext,
      MemberActivityAction.UPDATED,
      await this.sectionsService.update(
        organizationContext.organizationId,
        id,
        dto,
      ),
    );
  }

  @Patch(':id/restore')
  @RequirePermissions('trash.manage')
  async restore(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.activity(
      organizationContext,
      MemberActivityAction.RESTORED,
      await this.sectionsService.restore(
        organizationContext.organizationId,
        id,
      ),
    );
  }

  @Delete(':id')
  @RequirePermissions('catalog.manage')
  async remove(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.activity(
      organizationContext,
      MemberActivityAction.TRASHED,
      await this.sectionsService.remove(organizationContext.organizationId, id),
    );
  }

  @Delete(':id/permanent')
  @RequirePermissions('trash.manage')
  async permanentDelete(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.activity(
      organizationContext,
      MemberActivityAction.PURGED,
      await this.sectionsService.permanentDelete(
        organizationContext.organizationId,
        id,
      ),
      id,
    );
  }
}
