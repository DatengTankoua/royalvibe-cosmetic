import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import type { ResolvedOrganizationContext } from './organizations.service';
import { UpdateBrandingDto } from './dto/update-branding.dto';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import { S3Service } from '../s3/s3.service';
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
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly s3Service: S3Service,
  ) {}

  // Clé serveur (1-5B) : jamais dérivée du DTO/nom de fichier client.
  private logoKeyPrefix(organizationId: string): string {
    return `organizations/${organizationId}/branding`;
  }

  @Get()
  getCurrent(
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.organizationsService.getCurrent(
      organizationContext.organizationId,
    );
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
    const prefix = this.logoKeyPrefix(organizationContext.organizationId);
    // Upload AVANT la mutation DB : si l'upload échoue, aucune clé n'existe
    // encore, rien à nettoyer. Clé `<uuid>.<png|webp>` et `ContentType`
    // canoniques issus du format détecté, jamais du client.
    let uploaded: { key: string } | undefined;
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
    try {
      const result = await this.organizationsService.updateBranding(
        organizationContext.organizationId,
        dto,
        uploaded?.key,
      );
      // APRÈS sauvegarde uniquement : supprime l'ancien logo tenant.
      if (uploaded && result.previousLogoKey) {
        await this.s3Service.deleteStoredKey(result.previousLogoKey, prefix);
      }
      return result.organization;
    } catch (err) {
      // Mutation DB échouée après upload : le nouveau logo ne doit jamais
      // rester orphelin sur le tenant.
      if (uploaded) await this.s3Service.deleteStoredKey(uploaded.key, prefix);
      throw err;
    }
  }

  @Delete('logo')
  @RequirePermissions('branding.manage')
  async removeLogo(
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    const prefix = this.logoKeyPrefix(organizationContext.organizationId);
    const result = await this.organizationsService.removeLogo(
      organizationContext.organizationId,
    );
    if (result.previousLogoKey) {
      await this.s3Service.deleteStoredKey(result.previousLogoKey, prefix);
    }
    return result.organization;
  }
}
