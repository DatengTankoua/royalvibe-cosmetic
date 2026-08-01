import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ObjectEntity, ObjectDocument } from './schemas/object.schema';
import { CreateObjectDto } from './dto/create-object.dto';

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
    return createdObject.save();
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
