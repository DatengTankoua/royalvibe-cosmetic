import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SalesService } from './sales.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { UpdateSaleDto } from './dto/update-sale.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { User, UserRole } from '../users/schemas/user.schema';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';

/**
 * 1-4C.1 — la CRÉATION de vente seule porte `@CurrentOrganization()` :
 * le tenant (branché par `OrganizationGuard`, jamais fourni par la requête)
 * est le 1er argument du service. Les autres routes (lecture, update,
 * remove) attendent 1-4C.2 et restent inchangées.
 */
@Controller('sales')
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  @Post()
  create(
    @Body() dto: CreateSaleDto,
    @CurrentUser() user: User,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.salesService.create(
      organizationContext.organizationId,
      dto,
      user._id.toString(),
    );
  }

  @Get()
  findAll(@Query('productId') productId?: string) {
    return this.salesService.findAll(productId);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  update(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: UpdateSaleDto,
    @CurrentUser() user: User,
  ) {
    return this.salesService.update(id, dto, user._id.toString());
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  remove(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: User,
  ) {
    return this.salesService.remove(id, user._id.toString());
  }
}
