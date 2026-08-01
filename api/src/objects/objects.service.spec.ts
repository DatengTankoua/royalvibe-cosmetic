import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { ObjectsService } from './objects.service';
import { ObjectEntity } from './schemas/object.schema';

const mockObject = {
  _id: 'abc123',
  title: 'Title',
  description: 'Description',
  imageUrl: 'http://example.com/image.png',
};

type ModelMock = jest.Mock & {
  find: jest.Mock;
  findById: jest.Mock;
  findByIdAndDelete: jest.Mock;
};

function createModelMock(saveResult: unknown): ModelMock {
  const mock = jest.fn().mockImplementation(function (this: {
    save: jest.Mock;
  }) {
    this.save = jest.fn().mockResolvedValue(saveResult);
  }) as ModelMock;
  mock.find = jest.fn();
  mock.findById = jest.fn();
  mock.findByIdAndDelete = jest.fn();
  return mock;
}

function execResolves(value: unknown) {
  return { exec: jest.fn().mockResolvedValue(value) };
}

describe('ObjectsService', () => {
  let service: ObjectsService;
  let model: ModelMock;

  beforeEach(async () => {
    model = createModelMock(mockObject);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ObjectsService,
        {
          provide: getModelToken(ObjectEntity.name),
          useValue: model,
        },
      ],
    }).compile();

    service = module.get<ObjectsService>(ObjectsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('creates an object', async () => {
    const result = await service.create(
      { title: 'Title', description: 'Description' },
      mockObject.imageUrl,
    );
    expect(result).toEqual(mockObject);
  });

  it('returns all objects sorted by creation date', async () => {
    const sort = jest.fn().mockReturnValue(execResolves([mockObject]));
    model.find.mockReturnValue({ sort });

    const result = await service.findAll();

    expect(model.find).toHaveBeenCalled();
    expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(result).toEqual([mockObject]);
  });

  it('returns one object by id', async () => {
    model.findById.mockReturnValue(execResolves(mockObject));

    const result = await service.findOne('abc123');

    expect(model.findById).toHaveBeenCalledWith('abc123');
    expect(result).toEqual(mockObject);
  });

  it('throws NotFoundException when the object does not exist', async () => {
    model.findById.mockReturnValue(execResolves(null));

    await expect(service.findOne('missing')).rejects.toThrow(NotFoundException);
  });

  it('removes an object by id', async () => {
    model.findById.mockReturnValue(execResolves(mockObject));
    model.findByIdAndDelete.mockReturnValue(execResolves(mockObject));

    const result = await service.remove('abc123');

    expect(model.findByIdAndDelete).toHaveBeenCalledWith('abc123');
    expect(result).toEqual(mockObject);
  });
});
