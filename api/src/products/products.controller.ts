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
import { ProductsService } from './products.service';
import type { SalesHistoryScope } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import {
  StorageQuotaService,
  type StagedObject,
} from '../storage-quota/storage-quota.service';
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
import { productVisibility } from './product-projection';
import { validateProductImage } from './product-image-validation';
// 1-12D : limites multipart durcies (GHSA-535w) ; 413 stable (R2).
import { ProductImageUploadInterceptor } from './product-image-upload.interceptor';
import { PushOutboxService } from '../push/push-outbox.service';
import {
  MemberActivityAction,
  MemberActivityEntity,
} from '../notifications/member-activity';

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
 *
 * 1-19A : chaque écriture RÉUSSIE d'un membre autre que le propriétaire est
 * annoncée au propriétaire (`PushOutboxService.memberActivity`, best effort,
 * APRÈS le service : jamais sur un refus ni un échec). Nom du produit figé.
 */
@Controller('products')
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly storageQuota: StorageQuotaService,
    private readonly pushOutbox: PushOutboxService,
  ) {}

  private activity(
    context: ResolvedOrganizationContext,
    action: MemberActivityAction,
    product: { _id: unknown; name?: string | null },
    uniqueKey?: string,
  ): Promise<void> {
    return this.pushOutbox.memberActivity(context, {
      entity: MemberActivityEntity.PRODUCT,
      action,
      targetId: String(product._id),
      targetName: product.name ?? null,
      uniqueKey,
    });
  }

  /**
   * Photo contrôlée (format, décodage, dimensions) PUIS envoyée au stockage
   * sous le préfixe de l'organisation (clé serveur, jamais dérivée du DTO
   * ni du nom de fichier client). 1-17B : capacité RÉSERVÉE avant l'envoi
   * (quota de l'organisation, octets réellement envoyés) ; refus
   * `STORAGE_QUOTA_EXCEEDED` sans aucun envoi. Contenu reçu libéré ensuite.
   */
  private async storeProductImage(
    file: Express.Multer.File,
    organizationId: string,
  ): Promise<StagedObject> {
    const validated = await validateProductImage(file);
    try {
      return await this.storageQuota.store({
        organizationId,
        kind: 'product_image',
        body: file.buffer,
        image: validated,
      });
    } finally {
      file.buffer = Buffer.alloc(0);
    }
  }

  @Post()
  @RequirePermissions('products.manage')
  @UseInterceptors(ProductImageUploadInterceptor)
  async create(
    @Body() dto: CreateProductDto,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: User,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    if (!file) throw new BadRequestException('Image file is required');
    const organizationId = organizationContext.organizationId;
    // Si l'upload échoue, aucun objet n'existe encore : rien à nettoyer.
    const image = await this.storeProductImage(file, organizationId);
    let created: Awaited<ReturnType<ProductsService['create']>>;
    try {
      created = await this.productsService.create(
        organizationId,
        dto,
        image,
        user._id.toString(),
        productVisibility(organizationContext),
      );
    } catch (err) {
      // Écriture échouée : le fichier est supprimé et libéré SEULEMENT s'il
      // n'est référencé par aucun document (sinon conservé, reprise).
      await this.storageQuota.discard(image);
      throw err;
    }
    await this.activity(
      organizationContext,
      MemberActivityAction.CREATED,
      created,
    );
    return created;
  }

  @Get()
  findAll(
    // `= undefined` (et non `?`) : un paramètre optionnel ne peut précéder un
    // paramètre requis (TS1016) tandis que le contexte suit.
    @Query('sectionId') sectionId = undefined,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    // 1-12H : projection selon les permissions effectives du demandeur.
    return this.productsService.findAll(
      organizationContext.organizationId,
      sectionId,
      productVisibility(organizationContext),
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
      productVisibility(organizationContext),
    );
  }

  @Patch(':id')
  @UseInterceptors(ProductImageUploadInterceptor)
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
    const organizationId = organizationContext.organizationId;
    const newImage = file
      ? await this.storeProductImage(file, organizationId)
      : undefined;
    let updated: Awaited<ReturnType<ProductsService['update']>>;
    try {
      updated = await this.productsService.update(
        organizationId,
        id,
        dto,
        user._id.toString(),
        newImage,
        productVisibility(organizationContext),
      );
    } catch (err) {
      // L'ancienne photo reste en place : seule la nouvelle est abandonnée.
      if (newImage) await this.storageQuota.discard(newImage);
      throw err;
    }
    await this.activity(
      organizationContext,
      MemberActivityAction.UPDATED,
      updated.product,
    );
    return updated;
  }

  @Patch(':id/restore')
  @RequirePermissions('trash.manage')
  async restore(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    const restored = await this.productsService.restore(
      organizationContext.organizationId,
      id,
      productVisibility(organizationContext),
    );
    await this.activity(
      organizationContext,
      MemberActivityAction.RESTORED,
      restored,
    );
    return restored;
  }

  @Delete(':id')
  @RequirePermissions('products.manage')
  async remove(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: User,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    const trashed = await this.productsService.remove(
      organizationContext.organizationId,
      id,
      user._id.toString(),
      productVisibility(organizationContext),
    );
    await this.activity(
      organizationContext,
      MemberActivityAction.TRASHED,
      trashed,
    );
    return trashed;
  }

  @Delete(':id/permanent')
  @RequirePermissions('trash.manage')
  async permanentDelete(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    const purged = await this.productsService.permanentDelete(
      organizationContext.organizationId,
      id,
      productVisibility(organizationContext),
    );
    // Une suppression définitive n'a lieu qu'une fois : clé stable (deux
    // requêtes concurrentes ne comptent qu'une suppression).
    await this.activity(
      organizationContext,
      MemberActivityAction.PURGED,
      purged,
      id,
    );
    return purged;
  }
}
