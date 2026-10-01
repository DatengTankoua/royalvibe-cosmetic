import { Allow, IsString, MaxLength, MinLength } from 'class-validator';
import { RequestEmailVerificationDto } from '../email-verification/email-verification.dto';

/** POST /auth/password-reset/request — même normalisation/validation qu'en 1-13A. */
export class RequestPasswordResetDto extends RequestEmailVerificationDto {}

/** Même politique que l'inscription (6 à 100 caractères), jamais trimée. */
export const PASSWORD_POLICY_MESSAGE =
  'Le mot de passe doit contenir entre 6 et 100 caractères.';

/**
 * POST /auth/password-reset/confirm — `{ token, password }` strict.
 * `token` validé par le service (erreur stable unique) ; `password` validé
 * ici (erreur de validation distincte et compréhensible).
 */
export class ConfirmPasswordResetDto {
  @Allow()
  token?: unknown;

  @IsString({ message: PASSWORD_POLICY_MESSAGE })
  @MinLength(6, { message: PASSWORD_POLICY_MESSAGE })
  @MaxLength(100, { message: PASSWORD_POLICY_MESSAGE })
  password: string;
}
