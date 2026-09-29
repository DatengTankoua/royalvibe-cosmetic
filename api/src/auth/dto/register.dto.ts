import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_NAME_MESSAGE,
  USER_NAME_MAX_LENGTH,
  USER_NAME_MESSAGE,
  trimString,
} from '../../common/validation/name-rules';

export class RegisterDto {
  // 1-12C : trim avant validation, 1 à 80 caractères.
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
  // 1-12C : trim avant validation, 1 à 60 caractères.
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: ORGANIZATION_NAME_MESSAGE })
  @MaxLength(ORGANIZATION_NAME_MAX_LENGTH, {
    message: ORGANIZATION_NAME_MESSAGE,
  })
  organizationName: string;
}
