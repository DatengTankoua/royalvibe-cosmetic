import { Transform } from 'class-transformer';
import { Allow, IsEmail, MaxLength } from 'class-validator';

/** POST /auth/email-verification/request — adresse normalisée (trim + minuscules). */
export class RequestEmailVerificationDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email: string;
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
