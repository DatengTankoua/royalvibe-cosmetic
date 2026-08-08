import { Controller, Get, Query } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

@Controller('analytics')
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
