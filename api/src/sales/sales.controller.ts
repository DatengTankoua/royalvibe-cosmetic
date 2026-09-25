import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { SalesService } from './sales.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { UpdateSaleDto } from './dto/update-sale.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { User } from '../users/schemas/user.schema';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import {
  hasPermission,
  PERMISSION_DENIED_RESPONSE,
} from '../organizations/permissions';

@Controller('sales')
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  @Post()
  @RequirePermissions('sales.record')
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

  // 1-7B — pas de métadonnée unique possible (OU entre deux permissions
  // au scope différent) : la décision de scope est prise ici, pas par
  // `PermissionGuard`.
  @Get()
  findAll(
    @Query('productId') productId: string | undefined,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    if (hasPermission(organizationContext, 'sales.view_all')) {
      return this.salesService.findAll(
        organizationContext.organizationId,
        productId,
      );
    }
    if (hasPermission(organizationContext, 'sales.view_own')) {
      return this.salesService.findAll(
        organizationContext.organizationId,
        productId,
        organizationContext.userId,
      );
    }
    throw new ForbiddenException(PERMISSION_DENIED_RESPONSE);
  }

  @Patch(':id')
  @RequirePermissions('sales.record')
  update(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: UpdateSaleDto,
    @CurrentUser() user: User,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    const actorId = user._id.toString();
    // sans `sales.view_all` : uniquement ses propres ventes (404 sinon,
    // indistinguable d'une vente absente — jamais de fuite d'existence).
    if (hasPermission(organizationContext, 'sales.view_all')) {
      return this.salesService.update(
        organizationContext.organizationId,
        id,
        dto,
        actorId,
      );
    }
    return this.salesService.update(
      organizationContext.organizationId,
      id,
      dto,
      actorId,
      organizationContext.userId,
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('sales.record')
  remove(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: User,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    const actorId = user._id.toString();
    if (hasPermission(organizationContext, 'sales.view_all')) {
      return this.salesService.remove(
        organizationContext.organizationId,
        id,
        actorId,
      );
    }
    return this.salesService.remove(
      organizationContext.organizationId,
      id,
      actorId,
      organizationContext.userId,
    );
  }
}
