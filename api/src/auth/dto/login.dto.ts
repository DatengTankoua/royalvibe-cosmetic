import {
  MaxLength,
  IsEmail,
  IsMongoId,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsOptional()
  @IsMongoId()
  organizationId?: string;

  // 1-18C : défi Turnstile de récupération d'accès (plafond par compte
  // atteint). Ignoré tant que le plafond n'est pas atteint.
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  challengeToken?: string;
}
