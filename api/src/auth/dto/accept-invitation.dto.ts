import { Transform, Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { LegalAcceptanceDto } from '../../legal/dto/legal-acceptance.dto';
import {
  USER_NAME_MAX_LENGTH,
  USER_NAME_MESSAGE,
  trimString,
} from '../../common/validation/name-rules';

/**
 * Body strict { token, name?, password? } — `name`/`password` ne sont
 * requis QUE si l'email de l'invitation ne correspond à aucun User
 * existant (vérifié en service, pas au DTO : nécessite une lecture DB).
 */
export class AcceptInvitationDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  // 1-12C/1-12D : trim avant validation, 1 à 20 caractères (même règle que
  // l'inscription).
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: USER_NAME_MESSAGE })
  @MaxLength(USER_NAME_MAX_LENGTH, { message: USER_NAME_MESSAGE })
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(100)
  password?: string;

  // 1-16C.2 : requis seulement pour CRÉER un compte (vérifié en service).
  // Pour un compte existant, il est ignoré : le lien d'invitation ne prouve
  // pas l'identité, l'accord est demandé après connexion.
  @IsOptional()
  @ValidateNested()
  @Type(() => LegalAcceptanceDto)
  legalAcceptance?: LegalAcceptanceDto;
}
