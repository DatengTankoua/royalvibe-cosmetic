import { Controller, Get, UseGuards } from '@nestjs/common';
import { SectionsService } from '../sections/sections.service';
import { ProductsService } from '../products/products.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import { UserRole } from '../users/schemas/user.schema';

@Controller('trash')
@UseGuards(RolesGuard)
@Roles(UserRole.ADMIN)
export class TrashController {
  constructor(
    private readonly sectionsService: SectionsService,
    private readonly productsService: ProductsService,
  ) {}

  @Get()
  async findAll(
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    // Filtre tenant sur les sections (ProductsService : phase 1-4D).
    const [sections, products] = await Promise.all([
      this.sectionsService.findTrashed(organizationContext.organizationId),
      this.productsService.findTrashed(),
    ]);
    return { sections, products };
  }
}
