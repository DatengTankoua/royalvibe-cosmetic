import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Patch,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { OrganizationsService, logoKeyPrefix } from './organizations.service';
import type { ResolvedOrganizationContext } from './organizations.service';
import { UpdateBrandingDto } from './dto/update-branding.dto';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import { S3Service, type StoredObjectRef } from '../s3/s3.service';
import { LogoUploadInterceptor } from './logo/logo-upload.interceptor';
import { validateLogoFile } from './logo/logo-validation';

/**
 * Branding d'organisation (1-8A). `GET` est accessible à tout membre actif
 * (aucune permission requise : seule la garde `OrganizationGuard` — donc
 * `PermissionGuard` laisse passer sans métadonnée). Les mutations exigent
 * `branding.manage`. `organizationId` provient EXCLUSIVEMENT du contexte
 * branché par `OrganizationGuard` — jamais du body/query/header. Préfixe
 * de stockage EXACT : `organizations/<organizationId>/branding`.
 */
@Controller('organizations/current')
export class OrganizationBrandingController {
  private readonly logger = new Logger(OrganizationBrandingController.name);

  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly s3Service: S3Service,
  ) {}

  @Get()
  getCurrent(
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.organizationsService.getCurrent(
      organizationContext.organizationId,
    );
  }

  /**
   * Écriture MongoDB échouée après l'upload : le nouveau logo est supprimé
   * SEULEMENT s'il n'est pas référencé par l'organisation. Lecture
   * impossible → objet conservé (orphelin journalisé).
   */
  private async discardUnreferencedLogo(
    organizationId: string,
    logo: StoredObjectRef,
  ): Promise<void> {
    let referenced: boolean;
    try {
      referenced = await this.organizationsService.isLogoReferenced(
        organizationId,
        logo.key,
      );
    } catch {
      this.logger.warn(`Logo conservé (vérification impossible) : ${logo.key}`);
      return;
    }
    if (referenced) return;
    const cleanup = await this.s3Service.deleteStoredObject(
      logo,
      logoKeyPrefix(organizationId),
    );
    if (cleanup !== 'deleted') {
      this.logger.warn(
        `Logo non référencé conservé (${cleanup}) : ${logo.key}`,
      );
    }
  }

  @Patch('branding')
  @RequirePermissions('branding.manage')
  // 1-12C : PNG/WebP ≤ 2 Mio (413 `LOGO_TOO_LARGE` au-delà, jamais
  // bufferisé au-delà de la limite), contrat complet dans `validateLogoFile`.
  @UseInterceptors(LogoUploadInterceptor)
  async updateBranding(
    @Body() dto: UpdateBrandingDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    if (dto.name === undefined && dto.brandColor === undefined && !file) {
      throw new BadRequestException({
        code: 'EMPTY_BRANDING_UPDATE',
        message: 'Au moins un champ (name, brandColor, logo) est requis.',
      });
    }
    // 1-12C : validation COMPLÈTE (taille, extension, MIME, signature,
    // format détecté, dimensions, décodage) AVANT tout appel S3 ou DB — un
    // refus ne laisse ni objet ni écriture.
    const validated = file ? await validateLogoFile(file) : undefined;
    const organizationId = organizationContext.organizationId;
    const prefix = logoKeyPrefix(organizationId);
    // Upload AVANT la mutation DB : si l'upload échoue, aucune clé n'existe
    // encore, rien à nettoyer. Clé `<uuid>.<png|webp|jpg>` et `ContentType`
    // canoniques issus du format détecté, jamais du client.
    let uploaded: StoredObjectRef | undefined;
    try {
      uploaded =
        file && validated
          ? await this.s3Service.uploadValidatedImage(
              file.buffer,
              prefix,
              validated,
            )
          : undefined;
    } finally {
      // Plus aucune référence au contenu reçu une fois envoyé (ou refusé).
      if (file) file.buffer = Buffer.alloc(0);
    }
    let result: Awaited<ReturnType<OrganizationsService['updateBranding']>>;
    try {
      result = await this.organizationsService.updateBranding(
        organizationId,
        dto,
        uploaded,
      );
    } catch (err) {
      if (uploaded)
        await this.discardUnreferencedLogo(organizationId, uploaded);
      throw err;
    }
    if (!uploaded) return result.organization;
    // APRÈS sauvegarde uniquement : ancien logo du stockage courant
    // supprimé ; un logo antérieur (stockage inconnu) est laissé en place.
    const storageCleanup = await this.s3Service.deleteStoredObject(
      result.previousLogo,
      prefix,
    );
    return { ...result.organization, storageCleanup };
  }

  @Delete('logo')
  @RequirePermissions('branding.manage')
  async removeLogo(
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    const organizationId = organizationContext.organizationId;
    const result = await this.organizationsService.removeLogo(organizationId);
    const storageCleanup = await this.s3Service.deleteStoredObject(
      result.previousLogo,
      logoKeyPrefix(organizationId),
    );
    return { ...result.organization, storageCleanup };
  }
}
