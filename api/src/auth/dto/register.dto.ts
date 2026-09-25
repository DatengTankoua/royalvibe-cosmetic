import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
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
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  organizationName: string;
}
