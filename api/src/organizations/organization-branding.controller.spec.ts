import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import sharp from 'sharp';
import { OrganizationBrandingController } from './organization-branding.controller';
import { OrganizationsService } from './organizations.service';
import type { ResolvedOrganizationContext } from './organizations.service';
import { S3Service } from '../s3/s3.service';
import { OrganizationRole, OrganizationStatus } from './permissions';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';

const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const PREFIX_A = `organizations/${ORG_A}/branding`;
const STORAGE = 'r2/stockmaster-prod';
const NEW = { key: `${PREFIX_A}/new.png`, storage: STORAGE };
const OLD = { key: `${PREFIX_A}/old.png`, storage: STORAGE };

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

// 1-12C : le contenu est réellement validé (Sharp) — vraie image PNG.
let PNG = Buffer.alloc(0);
beforeAll(async () => {
  PNG = await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#062b5c' },
  })
    .png()
    .toBuffer();
});

function multerFile(
  originalname = 'logo.png',
  buffer: Buffer = PNG,
): Express.Multer.File {
  return {
    originalname,
    buffer,
    size: buffer.length,
    mimetype: 'image/png',
  } as Express.Multer.File;
}

describe('OrganizationBrandingController (1-8A)', () => {
  let controller: OrganizationBrandingController;

  const serviceStub = {
    getCurrent: jest.fn(),
    updateBranding: jest.fn(),
    removeLogo: jest.fn(),
    isLogoReferenced: jest.fn(),
  };
  const s3Stub = {
    uploadValidatedImage: jest.fn(),
    deleteStoredObject: jest.fn(),
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
      previousLogo: null,
    });
    serviceStub.removeLogo.mockReset().mockResolvedValue({
      organization: currentView,
      previousLogo: null,
    });
    serviceStub.isLogoReferenced.mockReset().mockResolvedValue(false);
    s3Stub.uploadValidatedImage.mockReset().mockResolvedValue(NEW);
    // Comportement réel : aucune référence → `not_needed` sans appel réseau.
    s3Stub.deleteStoredObject
      .mockReset()
      .mockImplementation((ref: unknown) =>
        Promise.resolve(ref ? 'deleted' : 'not_needed'),
      );

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
    expect(s3Stub.uploadValidatedImage).not.toHaveBeenCalled();
  });

  it('updateBranding sans fichier : aucun appel au stockage, dto transmis tel quel, réponse inchangée', async () => {
    const res = await controller.updateBranding(
      { name: 'Nouveau' },
      undefined,
      ctx,
    );
    expect(res).toEqual(currentView);
    expect(s3Stub.uploadValidatedImage).not.toHaveBeenCalled();
    expect(s3Stub.deleteStoredObject).not.toHaveBeenCalled();
    expect(serviceStub.updateBranding).toHaveBeenCalledWith(
      ORG_A,
      { name: 'Nouveau' },
      undefined,
    );
  });

  it('updateBranding avec fichier : upload AVANT la mutation DB, sous le préfixe exact de l’org', async () => {
    await controller.updateBranding({}, multerFile(), ctx);
    expect(s3Stub.uploadValidatedImage).toHaveBeenCalledWith(PNG, PREFIX_A, {
      format: 'png',
      extension: 'png',
      contentType: 'image/png',
    });
    expect(serviceStub.updateBranding).toHaveBeenCalledWith(ORG_A, {}, NEW);
  });

  it('updateBranding : DB réussit avec ancien logo → suppression de l’ANCIEN après sauvegarde, sort renvoyé', async () => {
    serviceStub.updateBranding.mockResolvedValueOnce({
      organization: currentView,
      previousLogo: OLD,
    });
    const res = await controller.updateBranding({}, multerFile(), ctx);
    expect(s3Stub.deleteStoredObject).toHaveBeenCalledWith(OLD, PREFIX_A);
    expect(
      s3Stub.deleteStoredObject.mock.invocationCallOrder[0],
    ).toBeGreaterThan(serviceStub.updateBranding.mock.invocationCallOrder[0]);
    expect(res).toEqual({ ...currentView, storageCleanup: 'deleted' });
  });

  it('updateBranding : échec de suppression de l’ancien logo → mutation réussie, `failed` renvoyé', async () => {
    serviceStub.updateBranding.mockResolvedValueOnce({
      organization: currentView,
      previousLogo: OLD,
    });
    s3Stub.deleteStoredObject.mockResolvedValueOnce('failed');
    const res = await controller.updateBranding({}, multerFile(), ctx);
    expect(res).toMatchObject({ storageCleanup: 'failed' });
  });

  it('updateBranding : DB échoue → le NOUVEAU logo non référencé est supprimé, erreur repropagée', async () => {
    const dbError = new Error('db down');
    serviceStub.updateBranding.mockRejectedValueOnce(dbError);
    await expect(controller.updateBranding({}, multerFile(), ctx)).rejects.toBe(
      dbError,
    );
    expect(serviceStub.isLogoReferenced).toHaveBeenCalledWith(ORG_A, NEW.key);
    expect(s3Stub.deleteStoredObject).toHaveBeenCalledWith(NEW, PREFIX_A);
  });

  it('updateBranding : erreur alors que le nouveau logo est référencé → conservé', async () => {
    serviceStub.updateBranding.mockRejectedValueOnce(new Error('after save'));
    serviceStub.isLogoReferenced.mockResolvedValueOnce(true);
    await expect(
      controller.updateBranding({}, multerFile(), ctx),
    ).rejects.toThrow('after save');
    expect(s3Stub.deleteStoredObject).not.toHaveBeenCalled();
  });

  it('updateBranding : fichier invalide (1-12C) → 400 stable, ni upload S3 ni mutation DB', async () => {
    await expect(
      controller.updateBranding(
        {},
        multerFile('logo.png', Buffer.from('not an image')),
        ctx,
      ),
    ).rejects.toMatchObject({ response: { code: 'LOGO_INVALID_FILE' } });
    expect(s3Stub.uploadValidatedImage).not.toHaveBeenCalled();
    expect(serviceStub.updateBranding).not.toHaveBeenCalled();
    expect(s3Stub.deleteStoredObject).not.toHaveBeenCalled();
  });

  it('updateBranding : contenu reçu relâché après l’envoi (aucune référence conservée)', async () => {
    const file = multerFile();
    await controller.updateBranding({}, file, ctx);
    expect(file.buffer.length).toBe(0);
  });

  it('removeLogo : ancien logo supprimé APRÈS l’écriture, sort renvoyé', async () => {
    serviceStub.removeLogo.mockResolvedValueOnce({
      organization: currentView,
      previousLogo: OLD,
    });
    const res = await controller.removeLogo(ctx);
    expect(serviceStub.removeLogo).toHaveBeenCalledWith(ORG_A);
    expect(s3Stub.deleteStoredObject).toHaveBeenCalledWith(OLD, PREFIX_A);
    expect(res).toEqual({ ...currentView, storageCleanup: 'deleted' });
  });

  it('removeLogo : sans logo préexistant → `not_needed`', async () => {
    const res = await controller.removeLogo(ctx);
    expect(s3Stub.deleteStoredObject).toHaveBeenCalledWith(null, PREFIX_A);
    expect(res).toMatchObject({ storageCleanup: 'not_needed' });
  });
});
