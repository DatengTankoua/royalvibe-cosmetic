import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/schemas/user.schema';

// KPIs, product/seller rankings include purchase prices and every
// seller's email + revenue: admin-only (phase 0B.1, audit C-2).
@Controller('analytics')
@UseGuards(RolesGuard)
@Roles(UserRole.ADMIN)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('overview')
  getOverview(@Query('month') month?: string) {
    return this.analyticsService.getOverview(month);
  }

  @Get('products/ranking')
  getProductsRanking(@Query('month') month?: string) {
    return this.analyticsService.getProductsRanking(month);
  }

  @Get('sellers/ranking')
  getSellersRanking(@Query('month') month?: string) {
    return this.analyticsService.getSellersRanking(month);
  }

  @Get('monthly')
  getMonthlyTrend() {
    return this.analyticsService.getMonthlyTrend();
  }
}
