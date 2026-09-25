import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ProductsService } from './products.service';
import type { SalesHistoryScope } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { S3Service } from '../s3/s3.service';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import {
  DelegablePermission,
  hasPermission,
  PERMISSION_DENIED_RESPONSE,
} from '../organizations/permissions';
import { User } from '../users/schemas/user.schema';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

// Matrice audit 1A §3 : stock+prix ⇒ `stock.adjust`, catalogue/images ⇒
// `products.manage`. Un PATCH ne portant AUCUN champ reconnu retombe sur
// `products.manage` (jamais une route sans permission requise).
const STOCK_FIELDS = ['purchasePrice', 'salePrice', 'additionalStock'] as const;
const BUSINESS_FIELDS = ['sectionId', 'name'] as const;

function requiredPermissionsForUpdate(
  dto: UpdateProductDto,
  hasImage: boolean,
): DelegablePermission[] {
  const touchesStock = STOCK_FIELDS.some((field) => dto[field] !== undefined);
  const touchesBusiness =
    hasImage || BUSINESS_FIELDS.some((field) => dto[field] !== undefined);
  const required: DelegablePermission[] = [];
  if (touchesBusiness || !touchesStock) required.push('products.manage');
  if (touchesStock) required.push('stock.adjust');
  return required;
}

/**
 * Tenant = `organizationContext.organizationId` (branché par la garde,
 * jamais fourni par la requête) : c'est la source unique passée au service
 * en PREMIER argument de chaque méthode du catalogue (§§3-4 de 1-4B).
 */
@Controller('products')
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly s3Service: S3Service,
  ) {}

  // Clé serveur (1-5B) : jamais dérivée du DTO/nom de fichier client.
  private imageKeyPrefix(organizationId: string): string {
    return `organizations/${organizationId}/products`;
  }

  @Post()
  @RequirePermissions('products.manage')
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { fileSize: MAX_IMAGE_SIZE },
      fileFilter: (_req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
          cb(new BadRequestException('Only image files are allowed'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  async create(
    @Body() dto: CreateProductDto,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: User,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    if (!file) throw new BadRequestException('Image file is required');
    const prefix = this.imageKeyPrefix(organizationContext.organizationId);
    // Si `uploadFile` échoue, aucune URL n'existe encore : rien à nettoyer.
    const imageUrl = await this.s3Service.uploadFile(file, prefix);
    try {
      return await this.productsService.create(
        organizationContext.organizationId,
        dto,
        imageUrl,
        user._id.toString(),
      );
    } catch (err) {
      // Mutation échouée après upload : la nouvelle image ne doit jamais
      // rester orpheline sur le tenant.
      await this.s3Service.deleteFile(imageUrl, prefix);
      throw err;
    }
  }

  @Get()
  findAll(
    // `= undefined` (et non `?`) : un paramètre optionnel ne peut précéder un
    // paramètre requis (TS1016) tandis que le contexte suit.
    @Query('sectionId') sectionId = undefined,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.productsService.findAll(
      organizationContext.organizationId,
      sectionId,
    );
  }

  @Get(':id')
  findOne(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    // Correctif 1-7B : le scope de l'historique des ventes ET l'inclusion de
    // l'audit sont décidés ICI (jamais dans le service, jamais après coup).
    const salesScope: SalesHistoryScope = hasPermission(
      organizationContext,
      'sales.view_all',
    )
      ? { kind: 'all' }
      : hasPermission(organizationContext, 'sales.view_own')
        ? { kind: 'own', sellerId: organizationContext.userId }
        : { kind: 'none' };
    const includeAudit = hasPermission(organizationContext, 'audit.read');
    return this.productsService.findOne(
      organizationContext.organizationId,
      id,
      salesScope,
      includeAudit,
    );
  }

  @Patch(':id')
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { fileSize: MAX_IMAGE_SIZE },
      fileFilter: (_req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
          cb(new BadRequestException('Only image files are allowed'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  async update(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: UpdateProductDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: User,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    // Correctif 1-7B : permission(s) requise(s) dépendent des champs réellement
    // touchés (pas de métadonnée statique possible ici).
    const required = requiredPermissionsForUpdate(dto, Boolean(file));
    if (!required.every((p) => hasPermission(organizationContext, p))) {
      throw new ForbiddenException(PERMISSION_DENIED_RESPONSE);
    }
    const prefix = this.imageKeyPrefix(organizationContext.organizationId);
    const newImageUrl = file
      ? await this.s3Service.uploadFile(file, prefix)
      : undefined;
    try {
      return await this.productsService.update(
        organizationContext.organizationId,
        id,
        dto,
        user._id.toString(),
        newImageUrl,
      );
    } catch (err) {
      // Mutation échouée après upload : la nouvelle image ne doit jamais
      // rester orpheline sur le tenant.
      if (newImageUrl) await this.s3Service.deleteFile(newImageUrl, prefix);
      throw err;
    }
  }

  @Patch(':id/restore')
  @RequirePermissions('trash.manage')
  restore(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.productsService.restore(organizationContext.organizationId, id);
  }

  @Delete(':id')
  @RequirePermissions('products.manage')
  remove(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: User,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.productsService.remove(
      organizationContext.organizationId,
      id,
      user._id.toString(),
    );
  }

  @Delete(':id/permanent')
  @RequirePermissions('trash.manage')
  permanentDelete(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.productsService.permanentDelete(
      organizationContext.organizationId,
      id,
    );
  }
}
