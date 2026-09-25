import { Controller, Get } from '@nestjs/common';
import { SectionsService } from '../sections/sections.service';
import { ProductsService } from '../products/products.service';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';

@Controller('trash')
@RequirePermissions('trash.manage')
export class TrashController {
  constructor(
    private readonly sectionsService: SectionsService,
    private readonly productsService: ProductsService,
  ) {}

  @Get()
  async findAll(
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    // Filtre tenant sur la corbeille sections (1-4A) ET produits (1-4B) :
    // l'org est celle du contexte branché par la garde, jamais du client.
    const [sections, products] = await Promise.all([
      this.sectionsService.findTrashed(organizationContext.organizationId),
      this.productsService.findTrashed(organizationContext.organizationId),
    ]);
    return { sections, products };
  }
}
