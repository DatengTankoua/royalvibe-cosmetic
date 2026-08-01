import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ObjectEntity, ObjectDocument } from './schemas/object.schema';
import { CreateObjectDto } from './dto/create-object.dto';
import { S3Service } from '../s3/s3.service';
import { EventsGateway } from '../events/events.gateway';

@Injectable()
export class ObjectsService {
  constructor(
    @InjectModel(ObjectEntity.name)
    private objectModel: Model<ObjectDocument>,
    private s3Service: S3Service,
    private eventsGateway: EventsGateway,
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
    this.eventsGateway.emitObjectCreated(saved);
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
    await this.s3Service.deleteFile(object.imageUrl);
    await this.objectModel.findByIdAndDelete(id).exec();
    this.eventsGateway.emitObjectDeleted(id);
    return object;
  }
}
