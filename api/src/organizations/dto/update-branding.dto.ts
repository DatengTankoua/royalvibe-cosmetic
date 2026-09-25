import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * `PATCH /organizations/current/branding` (1-8A) — multipart/form-data.
 * Whitelist stricte : `slug`/`currency`/`status`/`logoKey`/`organizationId`
 * sont ABSENTS d'intention et donc rejetés par le `ValidationPipe` global
 * (`forbidNonWhitelisted`), jamais un champ ignoré silencieusement.
 */
export class UpdateBrandingDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  /** `#RRGGBB` strict — même contrainte que le schéma `Organization`. */
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  brandColor?: string;
}
