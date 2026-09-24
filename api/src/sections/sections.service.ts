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

/**
 * Isolation multi-tenant : `organizationId` (string, claim vérifié par la
 * garde) EST la source du tenant pour chaque requête. Aucune opération ne
 * filtre sans lui ; une section d'une autre organisation est indistinguable
 * d'une section absente (même 404).
 */
@Injectable()
export class SectionsService {
  constructor(
    @InjectModel(Section.name) private sectionModel: Model<SectionDocument>,
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
  ) {}

  /** Throws 409 if another section shares the same name within the same tenant+parent */
  private async assertUniqueName(
    name: string,
    parentId: Types.ObjectId | null,
    organizationId: Types.ObjectId,
    excludeId?: string,
  ): Promise<void> {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const query: Record<string, unknown> = {
      name: new RegExp(`^${escaped}$`, 'i'),
      parentId,
      organizationId,
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

  async create(
    organizationId: string,
    dto: CreateSectionDto,
  ): Promise<SectionDocument> {
    const tenant = new Types.ObjectId(organizationId);
    const parentId = dto.parentId ? new Types.ObjectId(dto.parentId) : null;

    if (parentId) {
      // Le parent est tenu actif ET dans la même organisation : un parent
      // étranger ou corbeillé est indistinguable d'un parent absent.
      const parent = await this.sectionModel
        .findOne({ _id: parentId, organizationId: tenant, deletedAt: null })
        .exec();
      if (!parent)
        throw new NotFoundException(`Section ${dto.parentId} not found`);

      // Ensure parent has no active products
      const productCount = await this.productModel.countDocuments({
        sectionId: parentId,
        deletedAt: null,
        organizationId: tenant,
      });
      if (productCount > 0) {
        throw new BadRequestException('SECTION_HAS_PRODUCTS');
      }
    }

    await this.assertUniqueName(dto.name, parentId, tenant);
    // Champs whitelistés + org serveur : un `organizationId` d'origine
    // client (DTO falsifié) ne peut JAMAIS être enregistré.
    return this.sectionModel.create({
      name: dto.name,
      description: dto.description,
      parentId,
      organizationId: tenant,
    });
  }

  async findAll(
    organizationId: string,
    parentId?: string,
  ): Promise<SectionDocument[]> {
    const resolvedParentId = parentId ? new Types.ObjectId(parentId) : null;
    return this.sectionModel
      .find({
        organizationId: new Types.ObjectId(organizationId),
        deletedAt: null,
        parentId: resolvedParentId,
      })
      .sort({ createdAt: -1 })
      .exec();
  }

  async findTrashed(organizationId: string): Promise<SectionDocument[]> {
    return this.sectionModel
      .find({
        organizationId: new Types.ObjectId(organizationId),
        deletedAt: { $ne: null },
      })
      .sort({ deletedAt: -1 })
      .exec();
  }

  async findOne(organizationId: string, id: string): Promise<SectionDocument> {
    const section = await this.sectionModel
      .findOne({ _id: id, organizationId: new Types.ObjectId(organizationId) })
      .exec();
    if (!section) throw new NotFoundException(`Section ${id} not found`);
    return section;
  }

  async update(
    organizationId: string,
    id: string,
    dto: UpdateSectionDto,
  ): Promise<SectionDocument> {
    const tenant = new Types.ObjectId(organizationId);
    if (dto.name) {
      const existing = await this.sectionModel
        .findOne({ _id: id, organizationId: tenant })
        .exec();
      if (!existing) throw new NotFoundException(`Section ${id} not found`);
      await this.assertUniqueName(dto.name, existing.parentId, tenant, id);
    }
    const $set: Record<string, unknown> = {};
    if (dto.name !== undefined) $set.name = dto.name;
    if (dto.description !== undefined) $set.description = dto.description;
    const section = await this.sectionModel
      .findOneAndUpdate(
        { _id: id, organizationId: tenant },
        { $set },
        { new: true },
      )
      .exec();
    if (!section) throw new NotFoundException(`Section ${id} not found`);
    return section;
  }

  /** Soft-delete: moves to trash */
  async remove(organizationId: string, id: string): Promise<SectionDocument> {
    const section = await this.sectionModel
      .findOneAndUpdate(
        { _id: id, organizationId: new Types.ObjectId(organizationId) },
        { $set: { deletedAt: new Date() } },
        { new: true },
      )
      .exec();
    if (!section) throw new NotFoundException(`Section ${id} not found`);
    return section;
  }

  /** Restore from trash */
  async restore(organizationId: string, id: string): Promise<SectionDocument> {
    const section = await this.sectionModel
      .findOneAndUpdate(
        { _id: id, organizationId: new Types.ObjectId(organizationId) },
        { $set: { deletedAt: null } },
        { new: true },
      )
      .exec();
    if (!section) throw new NotFoundException(`Section ${id} not found`);
    return section;
  }

  /** Permanently delete from trash */
  async permanentDelete(
    organizationId: string,
    id: string,
  ): Promise<SectionDocument> {
    const section = await this.sectionModel
      .findOneAndDelete({
        _id: id,
        organizationId: new Types.ObjectId(organizationId),
      })
      .exec();
    if (!section) throw new NotFoundException(`Section ${id} not found`);
    return section;
  }
}
