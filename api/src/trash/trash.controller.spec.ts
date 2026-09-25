import { Test, TestingModule } from '@nestjs/testing';
import { TrashController } from './trash.controller';
import { SectionsService } from '../sections/sections.service';
import { ProductsService } from '../products/products.service';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import { OrganizationRole } from '../organizations/permissions';

const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const context: ResolvedOrganizationContext = {
  userId: '111111111111111111111111',
  organizationId: ORG_A,
  membershipId: '222222222222222222222222',
  role: OrganizationRole.OWNER,
  permissions: ['catalog.manage'],
};

describe('TrashController — tenant du contexte (1-4D)', () => {
  it('transmet exactement la même organisation aux sections et produits', async () => {
    const sections = { findTrashed: jest.fn().mockResolvedValue(['section']) };
    const products = { findTrashed: jest.fn().mockResolvedValue(['product']) };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TrashController],
      providers: [
        { provide: SectionsService, useValue: sections },
        { provide: ProductsService, useValue: products },
      ],
    }).compile();
    const controller = module.get(TrashController);

    await expect(controller.findAll(context)).resolves.toEqual({
      sections: ['section'],
      products: ['product'],
    });
    expect(sections.findTrashed).toHaveBeenCalledWith(ORG_A);
    expect(products.findTrashed).toHaveBeenCalledWith(ORG_A);
  });
});
