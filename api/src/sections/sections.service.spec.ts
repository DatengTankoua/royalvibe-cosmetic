import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { SectionsService } from './sections.service';
import { Section } from './schemas/section.schema';
import { Product } from '../products/schemas/product.schema';
import { CreateSectionDto } from './dto/create-section.dto';
import { UpdateSectionDto } from './dto/update-section.dto';

const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ORG_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const SECTION_ID = '112233445566778899001122';
const PARENT_ID = '223344556677889900112233';

function sectionDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(SECTION_ID),
    name: 'Nom',
    description: '',
    deletedAt: null,
    parentId: null,
    organizationId: new Types.ObjectId(ORG_A),
    ...overrides,
  };
}

describe('SectionsService — isolation multi-tenant (1-4A)', () => {
  let service: SectionsService;
  let sectionModel: {
    create: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    findOneAndUpdate: jest.Mock;
    findOneAndDelete: jest.Mock;
  };
  let productModel: { countDocuments: jest.Mock };
  let findChain: { sort: jest.Mock; exec: jest.Mock };
  let findOneChain: { exec: jest.Mock };
  let updateChain: { exec: jest.Mock };
  let deleteChain: { exec: jest.Mock };

  async function build() {
    findChain = { sort: jest.fn(), exec: jest.fn() };
    findChain.sort.mockReturnValue(findChain);
    findOneChain = { exec: jest.fn() };
    updateChain = { exec: jest.fn() };
    deleteChain = { exec: jest.fn() };
    sectionModel = {
      create: jest.fn(),
      find: jest.fn(() => findChain),
      findOne: jest.fn(() => findOneChain),
      findOneAndUpdate: jest.fn(() => updateChain),
      findOneAndDelete: jest.fn(() => deleteChain),
    };
    productModel = { countDocuments: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SectionsService,
        { provide: getModelToken(Section.name), useValue: sectionModel },
        { provide: getModelToken(Product.name), useValue: productModel },
      ],
    }).compile();
    service = module.get(SectionsService);
  }

  function lastUpdate(mock: jest.Mock): Record<string, unknown> {
    const calls = mock.mock.calls;
    return calls[calls.length - 1][1] as Record<string, unknown>;
  }

  async function expectNotFound(
    fn: () => Promise<unknown>,
    id: string,
  ): Promise<void> {
    const error = await fn().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as Error).message).toBe(`Section ${id} not found`);
  }

  // ---- create ----

  it('create : le document écrit porte l’organizationId SERVEUR ; une valeur d’org fournie (body ou injection runtime) est ignorée', async () => {
    await build();
    sectionModel.create.mockResolvedValue(sectionDoc());

    const dto = { name: 'Nouveau', description: 'd' } as CreateSectionDto;
    // Injection runtime frauduleuse : le DTO whitelisté ne peut pas porter
    // ce champ, mais le service ne doit PAS non plus copier un tel champ.
    (dto as Record<string, unknown>).organizationId = ORG_B;

    await service.create(ORG_A, dto);

    expect(sectionModel.create).toHaveBeenCalledTimes(1);
    // Objet EXACT écrit : champs whitelistés + org serveur ; l'org forgée
    // (B) n'apparaît nulle part.
    expect(sectionModel.create).toHaveBeenCalledWith({
      name: 'Nouveau',
      description: 'd',
      parentId: null,
      organizationId: new Types.ObjectId(ORG_A),
    });
  });

  it('create avec parent : le parent est lu par filtre composite {_id, organizationId, deletedAt:null} et le compte produits porte le tenant', async () => {
    await build();
    // 1er findOne = parent (trouvé), 2e = unicité (absent).
    findOneChain.exec
      .mockResolvedValueOnce(sectionDoc({ _id: new Types.ObjectId(PARENT_ID) }))
      .mockResolvedValueOnce(null);
    productModel.countDocuments.mockResolvedValue(0);
    sectionModel.create.mockResolvedValue(sectionDoc());

    await service.create(ORG_A, {
      name: 'Enfant',
      description: '',
      parentId: PARENT_ID,
    });

    // 1er appel findOne = recherche du parent — filtre tenant exact :
    expect(sectionModel.findOne).toHaveBeenNthCalledWith(1, {
      _id: new Types.ObjectId(PARENT_ID),
      organizationId: new Types.ObjectId(ORG_A),
      deletedAt: null,
    });
    expect(productModel.countDocuments).toHaveBeenCalledWith({
      sectionId: new Types.ObjectId(PARENT_ID),
      deletedAt: null,
      organizationId: new Types.ObjectId(ORG_A),
    });
  });

  it('create sans parent : la recherche d’unicité de nom porte {name, parentId:null, organizationId}', async () => {
    await build();
    findOneChain.exec.mockResolvedValue(null);
    sectionModel.create.mockResolvedValue(sectionDoc());

    await service.create(ORG_A, { name: 'Racine', description: '' });

    expect(sectionModel.findOne).toHaveBeenCalledWith({
      name: new RegExp('^Racine$', 'i'),
      parentId: null,
      organizationId: new Types.ObjectId(ORG_A),
    });
  });

  it('create : parent invisible dans l’organisation (nulle) → 404, sans compte produits ni création', async () => {
    await build();
    findOneChain.exec.mockResolvedValue(null);

    await expectNotFound(
      () =>
        service.create(ORG_A, {
          name: 'Enfant',
          description: '',
          parentId: PARENT_ID,
        }),
      PARENT_ID,
    );

    // Le filtre parent a bien été formulé avec le tenant — et rien d'autre :
    expect(sectionModel.findOne).toHaveBeenNthCalledWith(1, {
      _id: new Types.ObjectId(PARENT_ID),
      organizationId: new Types.ObjectId(ORG_A),
      deletedAt: null,
    });
    expect(productModel.countDocuments).not.toHaveBeenCalled();
    expect(sectionModel.create).not.toHaveBeenCalled();
  });

  it('create : parent avec produits actifs → 400 SECTION_HAS_PRODUCTS (filtre produit tenant prouvé)', async () => {
    await build();
    findOneChain.exec.mockResolvedValue(
      sectionDoc({ _id: new Types.ObjectId(PARENT_ID) }),
    );
    productModel.countDocuments.mockResolvedValue(1);

    const error = await service
      .create(ORG_A, { name: 'Enfant', description: '', parentId: PARENT_ID })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe('SECTION_HAS_PRODUCTS');
    // Le compte de produits est formulé AVEC le tenant :
    expect(productModel.countDocuments).toHaveBeenCalledWith({
      sectionId: new Types.ObjectId(PARENT_ID),
      deletedAt: null,
      organizationId: new Types.ObjectId(ORG_A),
    });
    expect(sectionModel.create).not.toHaveBeenCalled();
  });

  it('create : nom déjà utilisé dans la même organisation → 409 DUPLICATE_SECTION', async () => {
    await build();
    findOneChain.exec.mockResolvedValue(
      sectionDoc({ name: 'Doublon', _id: new Types.ObjectId(PARENT_ID) }),
    );
    sectionModel.create.mockResolvedValue(sectionDoc());

    const error = await service
      .create(ORG_A, { name: 'Doublon', description: '' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(sectionModel.create).not.toHaveBeenCalled();
  });

  it('create : même nom existant dans une AUTRE organisation → créé (le filtre est tenant)', async () => {
    await build();
    // La base ne « voit » que les docs correspondant au filtre tenant A :
    // une section de même nom de B n'est donc jamais retournée ici.
    findOneChain.exec.mockResolvedValue(null);
    sectionModel.create.mockResolvedValue(sectionDoc());

    await service.create(ORG_A, { name: 'Même nom', description: '' });

    expect(sectionModel.findOne).toHaveBeenCalledWith({
      name: new RegExp('^Même nom$', 'i'),
      parentId: null,
      organizationId: new Types.ObjectId(ORG_A),
    });
    expect(sectionModel.create).toHaveBeenCalledTimes(1);
  });

  // ---- findAll / findTrashed ----

  it('findAll : filtre EXACT {organizationId, deletedAt:null, parentId} (+ tri inchangé), avec et sans parentId', async () => {
    await build();
    findChain.exec.mockResolvedValue([]);

    await service.findAll(ORG_A);
    expect(sectionModel.find).toHaveBeenNthCalledWith(1, {
      organizationId: new Types.ObjectId(ORG_A),
      deletedAt: null,
      parentId: null,
    });

    await service.findAll(ORG_A, PARENT_ID);
    expect(sectionModel.find).toHaveBeenNthCalledWith(2, {
      organizationId: new Types.ObjectId(ORG_A),
      deletedAt: null,
      parentId: new Types.ObjectId(PARENT_ID),
    });
    // tri inchangé (contrat actuel préservé) :
    expect(findChain.sort).toHaveBeenCalledWith({ createdAt: -1 });
  });

  it('findTrashed : filtre EXACT {organizationId, deletedAt:{$ne:null}}', async () => {
    await build();
    findChain.exec.mockResolvedValue([]);

    await service.findTrashed(ORG_A);

    expect(sectionModel.find).toHaveBeenCalledWith({
      organizationId: new Types.ObjectId(ORG_A),
      deletedAt: { $ne: null },
    });
    expect(findChain.sort).toHaveBeenCalledWith({ deletedAt: -1 });
  });

  // ---- findOne ----

  it('findOne : filtre composite {_id, organizationId} (pas de findById)', async () => {
    await build();
    const doc = sectionDoc();
    findOneChain.exec.mockResolvedValue(doc);

    const res = await service.findOne(ORG_A, SECTION_ID);

    expect(res).toBe(doc);
    expect(sectionModel.findOne).toHaveBeenCalledWith({
      _id: SECTION_ID,
      organizationId: new Types.ObjectId(ORG_A),
    });
  });

  it('findOne : section invisible dans l’organisation → 404 au même format qu’une section absente', async () => {
    await build();
    findOneChain.exec.mockResolvedValue(null);

    await expectNotFound(
      async () => service.findOne(ORG_A, SECTION_ID),
      SECTION_ID,
    );
  });

  // ---- update ----

  it('update (nom) : relecture + unicité filtrées par tenant, puis ONE-AND-UPDATE {$set} strict (jamais le DTO brut)', async () => {
    await build();
    // 1er findOne = relecture du doc, 2e = unicité (absent).
    findOneChain.exec
      .mockResolvedValueOnce(sectionDoc())
      .mockResolvedValueOnce(null);
    updateChain.exec.mockResolvedValue(sectionDoc({ name: 'Nouveau nom' }));

    await service.update(ORG_A, SECTION_ID, { name: 'Nouveau nom' });

    // Relecture d'existence (unicité) : filtre tenant :
    expect(sectionModel.findOne).toHaveBeenNthCalledWith(1, {
      _id: SECTION_ID,
      organizationId: new Types.ObjectId(ORG_A),
    });
    // Unicité : nom + parentId du doc + org + exclusion de soi :
    expect(sectionModel.findOne).toHaveBeenNthCalledWith(2, {
      name: new RegExp('^Nouveau nom$', 'i'),
      parentId: null,
      organizationId: new Types.ObjectId(ORG_A),
      _id: { $ne: new Types.ObjectId(SECTION_ID) },
    });
    // Écriture : filtre tenant + $set limité aux champs métier :
    expect(sectionModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: SECTION_ID, organizationId: new Types.ObjectId(ORG_A) },
      { $set: { name: 'Nouveau nom' } },
      { new: true },
    );
  });

  it('update : un organizationId injecté en runtime par le DTO ne passe jamais dans $set', async () => {
    await build();
    findOneChain.exec.mockResolvedValue(null);
    updateChain.exec.mockResolvedValue(sectionDoc());

    const dto = { description: 'd' } as UpdateSectionDto;
    (dto as Record<string, unknown>).organizationId = ORG_B;

    await service.update(ORG_A, SECTION_ID, dto);

    const update = lastUpdate(sectionModel.findOneAndUpdate);
    expect(update).toEqual({ $set: { description: 'd' } });
    expect('organizationId' in (update.$set as Record<string, unknown>)).toBe(
      false,
    );
  });

  it('update : section invisible → 404, aucune écriture', async () => {
    await build();
    findOneChain.exec.mockResolvedValue(null);

    await expectNotFound(
      async () => service.update(ORG_A, SECTION_ID, { name: 'X' }),
      SECTION_ID,
    );
    expect(sectionModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  // ---- remove / restore / permanentDelete ----

  it('remove : filtre {_id, organizationId} + $set deletedAt ; section invisible → 404', async () => {
    await build();
    updateChain.exec.mockResolvedValue(sectionDoc());
    await service.remove(ORG_A, SECTION_ID);
    const [filter, update, options] = sectionModel.findOneAndUpdate.mock
      .calls[0] as [unknown, unknown, unknown];
    expect(filter).toEqual({
      _id: SECTION_ID,
      organizationId: new Types.ObjectId(ORG_A),
    });
    expect(update).toEqual({
      $set: expect.objectContaining({ deletedAt: expect.any(Date) }),
    });
    expect(options).toEqual({ new: true });

    updateChain.exec.mockResolvedValue(null);
    await expectNotFound(
      async () => service.remove(ORG_A, SECTION_ID),
      SECTION_ID,
    );
  });

  it('restore : MÊME filtre + $set deletedAt:null ; section invisible → 404', async () => {
    await build();
    updateChain.exec.mockResolvedValue(sectionDoc());
    await service.restore(ORG_A, SECTION_ID);
    expect(sectionModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: SECTION_ID, organizationId: new Types.ObjectId(ORG_A) },
      { $set: { deletedAt: null } },
      { new: true },
    );

    updateChain.exec.mockResolvedValue(null);
    await expectNotFound(
      async () => service.restore(ORG_A, SECTION_ID),
      SECTION_ID,
    );
  });

  it('permanentDelete : findOneAndDelete({_id, organizationId}) UNIQUEMENT ; section invisible → 404', async () => {
    await build();
    const doc = sectionDoc();
    deleteChain.exec.mockResolvedValue(doc);

    const res = await service.permanentDelete(ORG_A, SECTION_ID);
    expect(res).toBe(doc);
    expect(sectionModel.findOneAndDelete).toHaveBeenCalledWith({
      _id: SECTION_ID,
      organizationId: new Types.ObjectId(ORG_A),
    });

    deleteChain.exec.mockResolvedValue(null);
    await expectNotFound(
      async () => service.permanentDelete(ORG_A, SECTION_ID),
      SECTION_ID,
    );
  });
});
