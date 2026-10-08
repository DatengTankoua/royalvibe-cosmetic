import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ObjectEntity, ObjectDocument } from './schemas/object.schema';
import { CreateObjectDto } from './dto/create-object.dto';

// Dette 1-5B : module orphelin (jamais importé dans AppModule), sans org.
// Stockage R2 privé : ses anciennes URLs ne sont jamais supprimées ici
// (stockage d'origine inconnu) ; le document seul est retiré.

@Injectable()
export class ObjectsService {
  constructor(
    @InjectModel(ObjectEntity.name)
    private objectModel: Model<ObjectDocument>,
  ) {}

  async create(
    createObjectDto: CreateObjectDto,
    imageUrl: string,
  ): Promise<ObjectDocument> {
    const createdObject = new this.objectModel({
      ...createObjectDto,
      imageUrl,
    });
    const saved = await createdObject.save();
    return saved;
  }

  async findAll(): Promise<ObjectDocument[]> {
    return this.objectModel.find().sort({ createdAt: -1 }).exec();
  }

  async findOne(id: string): Promise<ObjectDocument> {
    const object = await this.objectModel.findById(id).exec();
    if (!object) {
      throw new NotFoundException(`Object with id ${id} not found`);
    }
    return object;
  }

  async remove(id: string): Promise<ObjectDocument> {
    const object = await this.findOne(id);
    await this.objectModel.findByIdAndDelete(id).exec();
    return object;
  }
}
