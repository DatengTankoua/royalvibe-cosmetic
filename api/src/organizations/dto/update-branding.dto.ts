import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_NAME_MESSAGE,
  trimString,
} from '../../common/validation/name-rules';

/**
 * `PATCH /organizations/current/branding` (1-8A) — multipart/form-data.
 * Whitelist stricte : `slug`/`currency`/`status`/`logoKey`/`organizationId`
 * sont ABSENTS d'intention et donc rejetés par le `ValidationPipe` global
 * (`forbidNonWhitelisted`), jamais un champ ignoré silencieusement.
 */
export class UpdateBrandingDto {
  // 1-12C : trim avant validation, 1 à 60 caractères (même règle que
  // l'inscription). Absent = nom inchangé (organisation historique au nom
  // plus long conservée telle quelle).
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: ORGANIZATION_NAME_MESSAGE })
  @MaxLength(ORGANIZATION_NAME_MAX_LENGTH, {
    message: ORGANIZATION_NAME_MESSAGE,
  })
  name?: string;

  /** `#RRGGBB` strict — même contrainte que le schéma `Organization`. */
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  brandColor?: string;
}
