import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Section, SectionDocument } from './schemas/section.schema';
import { CreateSectionDto } from './dto/create-section.dto';
import { UpdateSectionDto } from './dto/update-section.dto';

@Injectable()
export class SectionsService {
  constructor(
    @InjectModel(Section.name) private sectionModel: Model<SectionDocument>,
  ) {}

  /** Throws 409 if another section shares the same name (active or trashed) */
  private async assertUniqueName(
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const query: Record<string, unknown> = {
      name: new RegExp(`^${escaped}$`, 'i'),
    };
    if (excludeId) query._id = { $ne: new Types.ObjectId(excludeId) };
    const existing = await this.sectionModel.findOne(query).exec();
    if (existing) {
      throw new ConflictException({
        message: 'DUPLICATE_SECTION',
        existing: {
          _id: existing._id,
          name: existing.name,
          deletedAt: existing.deletedAt,
        },
      });
    }
  }

  async create(dto: CreateSectionDto): Promise<SectionDocument> {
    await this.assertUniqueName(dto.name);
    return this.sectionModel.create(dto);
  }

  async findAll(): Promise<SectionDocument[]> {
    return this.sectionModel
      .find({ deletedAt: null })
      .sort({ createdAt: -1 })
      .exec();
  }

  async findTrashed(): Promise<SectionDocument[]> {
    return this.sectionModel
      .find({ deletedAt: { $ne: null } })
      .sort({ deletedAt: -1 })
      .exec();
  }

  async findOne(id: string): Promise<SectionDocument> {
    const section = await this.sectionModel.findById(id).exec();
    if (!section) throw new NotFoundException(`Section ${id} not found`);
    return section;
  }

  async update(id: string, dto: UpdateSectionDto): Promise<SectionDocument> {
    if (dto.name) await this.assertUniqueName(dto.name, id);
    const section = await this.sectionModel
      .findByIdAndUpdate(id, dto, { new: true })
      .exec();
    if (!section) throw new NotFoundException(`Section ${id} not found`);
    return section;
  }

  /** Soft-delete: moves to trash */
  async remove(id: string): Promise<SectionDocument> {
    const section = await this.sectionModel
      .findByIdAndUpdate(id, { deletedAt: new Date() }, { new: true })
      .exec();
    if (!section) throw new NotFoundException(`Section ${id} not found`);
    return section;
  }

  /** Restore from trash */
  async restore(id: string): Promise<SectionDocument> {
    const section = await this.sectionModel
      .findByIdAndUpdate(id, { deletedAt: null }, { new: true })
      .exec();
    if (!section) throw new NotFoundException(`Section ${id} not found`);
    return section;
  }

  /** Permanently delete from trash */
  async permanentDelete(id: string): Promise<SectionDocument> {
    const section = await this.sectionModel.findByIdAndDelete(id).exec();
    if (!section) throw new NotFoundException(`Section ${id} not found`);
    return section;
  }
}
