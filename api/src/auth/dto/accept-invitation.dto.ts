import { Transform, Type } from 'class-transformer';
import {
  Equals,
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
  USER_NAME_MAX_LENGTH,
  USER_NAME_MESSAGE,
  trimString,
} from '../../common/validation/name-rules';

/** Borne défensive d'un token reçu (base64url de 32 octets = 43). */
const MAX_TOKEN_LENGTH = 512;

/**
 * 1-18B — `POST /auth/invitations/inspect` (session requise) et
 * `POST /auth/invitations/account-link` (public) : `{ token }` strict.
 */
export class InvitationTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_TOKEN_LENGTH)
  token: string;
}

/**
 * 1-18B — `POST /auth/invitations/accept` : session du compte invité ET
 * accord explicite (`consent: true`). Aucun nom, mot de passe ni
 * acceptation légale : un compte existant n'est jamais modifié ici.
 */
export class AcceptInvitationDto extends InvitationTokenDto {
  @Equals(true)
  consent: true;
}

/**
 * 1-18B — Compte existant SANS organisation active (aucune session possible) :
 * preuve d'identité par les identifiants du compte, mêmes règles que
 * `LoginDto`. `POST /auth/invitations/credentials/inspect`.
 */
export class InvitationCredentialsDto extends InvitationTokenDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6)
  @MaxLength(100)
  password: string;

  // 1-18C : défi de récupération d'accès (même règle que le login).
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  challengeToken?: string;
}

/** `POST /auth/invitations/credentials/accept` : identifiants + accord explicite. */
export class AcceptInvitationWithCredentialsDto extends InvitationCredentialsDto {
  @Equals(true)
  consent: true;
}

/**
 * 1-18B — `POST /auth/invitations/create-account` : `token` = lien reçu
 * PAR E-MAIL à l'adresse invitée (jamais le lien remis au créateur).
 */
export class CreateInvitationAccountDto extends InvitationTokenDto {
  // 1-12C/1-12D : trim avant validation, 1 à 20 caractères (même règle que
  // l'inscription).
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: USER_NAME_MESSAGE })
  @MaxLength(USER_NAME_MAX_LENGTH, { message: USER_NAME_MESSAGE })
  name: string;

  @IsString()
  @MinLength(6)
  @MaxLength(100)
  password: string;

  // 1-16C.2 : facultatif AU DTO pour un refus au code stable
  // (`LEGAL_ACCEPTANCE_REQUIRED`) par le service, avant toute écriture.
  @IsOptional()
  @ValidateNested()
  @Type(() => LegalAcceptanceDto)
  legalAcceptance?: LegalAcceptanceDto;
}
