import { Controller, Get, UseGuards } from '@nestjs/common';
import { SectionsService } from '../sections/sections.service';
import { ProductsService } from '../products/products.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
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
  async findAll() {
    const [sections, products] = await Promise.all([
      this.sectionsService.findTrashed(),
      this.productsService.findTrashed(),
    ]);
    return { sections, products };
  }
}
