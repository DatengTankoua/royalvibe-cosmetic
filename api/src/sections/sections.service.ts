import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Section, SectionDocument } from './schemas/section.schema';
import { CreateSectionDto } from './dto/create-section.dto';
import { UpdateSectionDto } from './dto/update-section.dto';

@Injectable()
export class SectionsService {
  constructor(
    @InjectModel(Section.name) private sectionModel: Model<SectionDocument>,
  ) {}

  async create(dto: CreateSectionDto): Promise<SectionDocument> {
    return this.sectionModel.create(dto);
  }

  async findAll(): Promise<SectionDocument[]> {
    return this.sectionModel.find().sort({ createdAt: -1 }).exec();
  }

  async findOne(id: string): Promise<SectionDocument> {
    const section = await this.sectionModel.findById(id).exec();
    if (!section) throw new NotFoundException(`Section ${id} not found`);
    return section;
  }

  async update(id: string, dto: UpdateSectionDto): Promise<SectionDocument> {
    const section = await this.sectionModel
      .findByIdAndUpdate(id, dto, { new: true })
      .exec();
    if (!section) throw new NotFoundException(`Section ${id} not found`);
    return section;
  }

  async remove(id: string): Promise<SectionDocument> {
    const section = await this.sectionModel.findByIdAndDelete(id).exec();
    if (!section) throw new NotFoundException(`Section ${id} not found`);
    return section;
  }
}
