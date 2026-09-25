import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import { UserRole } from '../users/schemas/user.schema';

// KPIs, product/seller rankings include purchase prices and every
// seller's email + revenue: admin-only (phase 0B.1, audit C-2).
@Controller('analytics')
@UseGuards(RolesGuard)
@Roles(UserRole.ADMIN)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('overview')
  getOverview(
    @Query('month') month: string | undefined,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.analyticsService.getOverview(
      organizationContext.organizationId,
      month,
    );
  }

  @Get('products/ranking')
  getProductsRanking(
    @Query('month') month: string | undefined,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.analyticsService.getProductsRanking(
      organizationContext.organizationId,
      month,
    );
  }

  @Get('sellers/ranking')
  getSellersRanking(
    @Query('month') month: string | undefined,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.analyticsService.getSellersRanking(
      organizationContext.organizationId,
      month,
    );
  }

  @Get('monthly')
  getMonthlyTrend(
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.analyticsService.getMonthlyTrend(
      organizationContext.organizationId,
    );
  }
}
