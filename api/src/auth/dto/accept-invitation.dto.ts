import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Body strict { token, name?, password? } — `name`/`password` ne sont
 * requis QUE si l'email de l'invitation ne correspond à aucun User
 * existant (vérifié en service, pas au DTO : nécessite une lecture DB).
 */
export class AcceptInvitationDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(100)
  password?: string;
}
