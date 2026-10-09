import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { LegalAcceptanceDto } from '../../legal/dto/legal-acceptance.dto';
import {
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_NAME_MESSAGE,
  USER_NAME_MAX_LENGTH,
  USER_NAME_MESSAGE,
  trimString,
} from '../../common/validation/name-rules';

export class RegisterDto {
  // 1-12C/1-12D : trim avant validation, 1 à 20 caractères.
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: USER_NAME_MESSAGE })
  @MaxLength(USER_NAME_MAX_LENGTH, { message: USER_NAME_MESSAGE })
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6)
  @MaxLength(100)
  password: string;

  // 1-6A : nom de l'organisation créée avec le propriétaire. Aucun autre
  // champ organisationnel n'est accepté ici (whitelist + forbidNonWhitelisted
  // globaux rejettent organizationId/slug/role/permissions/status/currency/
  // brandColor/ownerId avec 400, avant toute logique).
  // 1-12C/1-12D : trim avant validation, 1 à 20 caractères.
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: ORGANIZATION_NAME_MESSAGE })
  @MaxLength(ORGANIZATION_NAME_MAX_LENGTH, {
    message: ORGANIZATION_NAME_MESSAGE,
  })
  organizationName: string;

  // 1-16C.2 : documents affichés et case cochée. Facultatif AU DTO pour un
  // refus au code stable (`LEGAL_ACCEPTANCE_REQUIRED`) par le service, avant
  // toute écriture ; versions, date et empreintes fixées par le serveur.
  @IsOptional()
  @ValidateNested()
  @Type(() => LegalAcceptanceDto)
  legalAcceptance?: LegalAcceptanceDto;

  // 1-18C : jeton Cloudflare Turnstile (ou simulé en test). Facultatif AU
  // DTO pour un refus au code stable `TURNSTILE_REQUIRED` par le service.
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  turnstileToken?: string;
}
