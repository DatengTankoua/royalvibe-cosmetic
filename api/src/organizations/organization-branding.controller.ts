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
import { FileInterceptor } from '@nestjs/platform-express';
import { OrganizationsService } from './organizations.service';
import type { ResolvedOrganizationContext } from './organizations.service';
import { UpdateBrandingDto } from './dto/update-branding.dto';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import { S3Service } from '../s3/s3.service';

const MAX_LOGO_SIZE = 5 * 1024 * 1024;

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
  @UseInterceptors(
    FileInterceptor('logo', {
      limits: { fileSize: MAX_LOGO_SIZE },
      fileFilter: (_req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
          cb(new BadRequestException('Only image files are allowed'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
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
    const prefix = this.logoKeyPrefix(organizationContext.organizationId);
    // Upload AVANT la mutation DB : si `uploadStoredFile` échoue, aucune
    // clé n'existe encore, rien à nettoyer.
    const uploaded = file
      ? await this.s3Service.uploadStoredFile(file, prefix)
      : undefined;
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
