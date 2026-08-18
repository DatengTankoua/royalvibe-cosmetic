import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Section, SectionDocument } from './schemas/section.schema';
import { CreateSectionDto } from './dto/create-section.dto';
import { UpdateSectionDto } from './dto/update-section.dto';
import { Product, ProductDocument } from '../products/schemas/product.schema';

@Injectable()
export class SectionsService {
  constructor(
    @InjectModel(Section.name) private sectionModel: Model<SectionDocument>,
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
  ) {}

  /** Throws 409 if another section shares the same name within the same parent */
  private async assertUniqueName(
    name: string,
    parentId: Types.ObjectId | null,
    excludeId?: string,
  ): Promise<void> {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const query: Record<string, unknown> = {
      name: new RegExp(`^${escaped}$`, 'i'),
      parentId,
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
    const parentId = dto.parentId ? new Types.ObjectId(dto.parentId) : null;

    if (parentId) {
      // Ensure parent exists
      const parent = await this.sectionModel.findById(parentId).exec();
      if (!parent)
        throw new NotFoundException(`Section ${dto.parentId} not found`);

      // Ensure parent has no active products
      const productCount = await this.productModel.countDocuments({
        sectionId: parentId,
        deletedAt: null,
      });
      if (productCount > 0) {
        throw new BadRequestException('SECTION_HAS_PRODUCTS');
      }
    }

    await this.assertUniqueName(dto.name, parentId);
    return this.sectionModel.create({ ...dto, parentId });
  }

  async findAll(parentId?: string): Promise<SectionDocument[]> {
    const resolvedParentId = parentId ? new Types.ObjectId(parentId) : null;
    return this.sectionModel
      .find({ deletedAt: null, parentId: resolvedParentId })
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
    if (dto.name) {
      const existing = await this.sectionModel.findById(id).exec();
      if (!existing) throw new NotFoundException(`Section ${id} not found`);
      await this.assertUniqueName(dto.name, existing.parentId, id);
    }
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
