import { Transform } from 'class-transformer';
import {
  Allow,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** POST /auth/email-verification/request — adresse normalisée (trim + minuscules). */
export class RequestEmailVerificationDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email: string;

  // 1-18D : jeton Turnstile (action propre à chaque route). Facultatif AU
  // DTO pour un refus au code stable `TURNSTILE_REQUIRED` par le service.
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  turnstileToken?: string;
}

/**
 * POST /auth/email-verification/confirm — `token` seul. Validé par le
 * service (et non par le DTO) : absent, vide ou mal typé donne la même
 * erreur stable `EMAIL_VERIFICATION_INVALID_OR_EXPIRED` qu'un token inconnu.
 */
export class ConfirmEmailVerificationDto {
  @Allow()
  token?: unknown;
}
