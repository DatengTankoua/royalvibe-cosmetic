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

/**
 * Tenant = `organizationContext.organizationId` (branché par la garde,
 * jamais fourni par la requête) : c'est la source unique passée au service.
 */
@Controller('sections')
export class SectionsController {
  constructor(private readonly sectionsService: SectionsService) {}

  @Post()
  @RequirePermissions('catalog.manage')
  create(
    @Body() dto: CreateSectionDto,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.sectionsService.create(organizationContext.organizationId, dto);
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
  update(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: UpdateSectionDto,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.sectionsService.update(
      organizationContext.organizationId,
      id,
      dto,
    );
  }

  @Patch(':id/restore')
  @RequirePermissions('trash.manage')
  restore(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.sectionsService.restore(organizationContext.organizationId, id);
  }

  @Delete(':id')
  @RequirePermissions('catalog.manage')
  remove(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.sectionsService.remove(organizationContext.organizationId, id);
  }

  @Delete(':id/permanent')
  @RequirePermissions('trash.manage')
  permanentDelete(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.sectionsService.permanentDelete(
      organizationContext.organizationId,
      id,
    );
  }
}
