import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { OrganizationBrandingController } from './organization-branding.controller';
import { OrganizationsService } from './organizations.service';
import type { ResolvedOrganizationContext } from './organizations.service';
import { S3Service } from '../s3/s3.service';
import { OrganizationRole, OrganizationStatus } from './permissions';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';

const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const PREFIX_A = `organizations/${ORG_A}/branding`;

function makeContext(): ResolvedOrganizationContext {
  return {
    userId: '111111111111111111111111',
    organizationId: ORG_A,
    membershipId: '222222222222222222222222',
    role: OrganizationRole.OWNER,
    permissions: [],
  };
}

function readMetadata(methodName: string): unknown {
  const proto = OrganizationBrandingController.prototype as unknown as Record<
    string,
    unknown
  >;
  const handler = proto[methodName];
  return typeof handler === 'function'
    ? (Reflect.getMetadata(PERMISSIONS_KEY, handler) as unknown)
    : undefined;
}

function multerFile(originalname = 'logo.png'): Express.Multer.File {
  return {
    originalname,
    buffer: Buffer.from('fake'),
    mimetype: 'image/png',
  } as Express.Multer.File;
}

describe('OrganizationBrandingController (1-8A)', () => {
  let controller: OrganizationBrandingController;

  const serviceStub = {
    getCurrent: jest.fn(),
    updateBranding: jest.fn(),
    removeLogo: jest.fn(),
  };
  const s3Stub = {
    uploadStoredFile: jest.fn(),
    deleteStoredKey: jest.fn(),
  };

  const currentView = {
    _id: ORG_A,
    name: 'Org A',
    slug: 'org-a',
    brandColor: '#FF6A00',
    currency: 'XAF',
    status: OrganizationStatus.ACTIVE,
    logoUrl: null,
  };

  beforeEach(async () => {
    serviceStub.getCurrent.mockReset().mockResolvedValue(currentView);
    serviceStub.updateBranding.mockReset().mockResolvedValue({
      organization: currentView,
      previousLogoKey: null,
    });
    serviceStub.removeLogo.mockReset().mockResolvedValue({
      organization: currentView,
      previousLogoKey: null,
    });
    s3Stub.uploadStoredFile.mockReset().mockResolvedValue({
      key: `${PREFIX_A}/new.png`,
      url: 'http://s3/new.png',
    });
    s3Stub.deleteStoredKey.mockReset().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrganizationBrandingController],
      providers: [
        { provide: OrganizationsService, useValue: serviceStub },
        { provide: S3Service, useValue: s3Stub },
      ],
    }).compile();
    controller = module.get(OrganizationBrandingController);
  });

  const ctx = makeContext();

  it('la classe ne déclare AUCUN @RequirePermissions (jamais hérité par GET)', () => {
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, OrganizationBrandingController),
    ).toBeUndefined();
  });

  it('GET / ne déclare AUCUNE permission (accessible à tout membre actif)', () => {
    expect(readMetadata('getCurrent')).toBeUndefined();
  });

  it('PATCH /branding déclare @RequirePermissions(branding.manage)', () => {
    expect(readMetadata('updateBranding')).toEqual(['branding.manage']);
  });

  it('DELETE /logo déclare @RequirePermissions(branding.manage)', () => {
    expect(readMetadata('removeLogo')).toEqual(['branding.manage']);
  });

  it('getCurrent : transmet UNIQUEMENT l’org du contexte', async () => {
    await controller.getCurrent(ctx);
    expect(serviceStub.getCurrent).toHaveBeenCalledWith(ORG_A);
  });

  it('updateBranding : body vide sans logo → 400, service jamais appelé', async () => {
    await expect(
      controller.updateBranding({}, undefined, ctx),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(serviceStub.updateBranding).not.toHaveBeenCalled();
    expect(s3Stub.uploadStoredFile).not.toHaveBeenCalled();
  });

  it('updateBranding sans fichier : aucun appel S3, dto transmis tel quel', async () => {
    await controller.updateBranding({ name: 'Nouveau' }, undefined, ctx);
    expect(s3Stub.uploadStoredFile).not.toHaveBeenCalled();
    expect(serviceStub.updateBranding).toHaveBeenCalledWith(
      ORG_A,
      { name: 'Nouveau' },
      undefined,
    );
  });

  it('updateBranding avec fichier : upload AVANT la mutation DB, sous le préfixe exact de l’org', async () => {
    await controller.updateBranding({}, multerFile(), ctx);
    expect(s3Stub.uploadStoredFile).toHaveBeenCalledWith(
      expect.anything(),
      PREFIX_A,
    );
    expect(serviceStub.updateBranding).toHaveBeenCalledWith(
      ORG_A,
      {},
      `${PREFIX_A}/new.png`,
    );
  });

  it('updateBranding : DB réussit avec ancien logo → suppression de l’ANCIEN après sauvegarde', async () => {
    serviceStub.updateBranding.mockResolvedValueOnce({
      organization: currentView,
      previousLogoKey: `${PREFIX_A}/old.png`,
    });
    await controller.updateBranding({}, multerFile(), ctx);
    expect(s3Stub.deleteStoredKey).toHaveBeenCalledWith(
      `${PREFIX_A}/old.png`,
      PREFIX_A,
    );
  });

  it('updateBranding : DB échoue → le NOUVEAU logo est supprimé, erreur repropagée', async () => {
    const dbError = new Error('db down');
    serviceStub.updateBranding.mockRejectedValueOnce(dbError);
    await expect(controller.updateBranding({}, multerFile(), ctx)).rejects.toBe(
      dbError,
    );
    expect(s3Stub.deleteStoredKey).toHaveBeenCalledWith(
      `${PREFIX_A}/new.png`,
      PREFIX_A,
    );
  });

  it('removeLogo : supprime l’ancien objet S3 uniquement si previousLogoKey non nul', async () => {
    serviceStub.removeLogo.mockResolvedValueOnce({
      organization: currentView,
      previousLogoKey: `${PREFIX_A}/old.png`,
    });
    await controller.removeLogo(ctx);
    expect(serviceStub.removeLogo).toHaveBeenCalledWith(ORG_A);
    expect(s3Stub.deleteStoredKey).toHaveBeenCalledWith(
      `${PREFIX_A}/old.png`,
      PREFIX_A,
    );
  });

  it('removeLogo : sans logo préexistant, aucun appel S3', async () => {
    await controller.removeLogo(ctx);
    expect(s3Stub.deleteStoredKey).not.toHaveBeenCalled();
  });
});
