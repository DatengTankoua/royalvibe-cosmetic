import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import { OrganizationRole } from '../organizations/permissions';

const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const context: ResolvedOrganizationContext = {
  userId: '111111111111111111111111',
  organizationId: ORG_A,
  membershipId: '222222222222222222222222',
  role: OrganizationRole.OWNER,
  permissions: ['analytics.read'],
};

describe('AnalyticsController — tenant du contexte (1-4D)', () => {
  let controller: AnalyticsController;
  const service = {
    getOverview: jest.fn(),
    getProductsRanking: jest.fn(),
    getSellersRanking: jest.fn(),
    getMonthlyTrend: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AnalyticsController],
      providers: [{ provide: AnalyticsService, useValue: service }],
    }).compile();
    controller = module.get(AnalyticsController);
  });

  it('transmet organizationId en premier argument aux quatre méthodes', async () => {
    await controller.getOverview('2026-09', context);
    await controller.getProductsRanking('2026-09', context);
    await controller.getSellersRanking('2026-09', context);
    await controller.getMonthlyTrend(context);

    expect(service.getOverview).toHaveBeenCalledWith(ORG_A, '2026-09');
    expect(service.getProductsRanking).toHaveBeenCalledWith(ORG_A, '2026-09');
    expect(service.getSellersRanking).toHaveBeenCalledWith(ORG_A, '2026-09');
    expect(service.getMonthlyTrend).toHaveBeenCalledWith(ORG_A);
  });
});
