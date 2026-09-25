import { Controller, Get, Query } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';

// KPIs, product/seller rankings include purchase prices and every
// seller's email + revenue: gated by `analytics.read` (1-7B, ex-admin-only).
@Controller('analytics')
@RequirePermissions('analytics.read')
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
