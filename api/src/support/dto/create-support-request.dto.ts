import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  SUPPORT_APP_VERSION_MAX_LENGTH,
  SUPPORT_CATEGORIES,
  SUPPORT_MESSAGE_MAX_LENGTH,
  SUPPORT_PAGE_MAX_LENGTH,
  SUPPORT_SUBJECT_MAX_LENGTH,
  type SupportCategory,
} from '../support-constants';

/** Aucun caractère de contrôle (donc ni CR ni LF : pas d'injection d'en-tête). */
// eslint-disable-next-line no-control-regex -- refuse volontairement les caractères de contrôle du sujet
export const SUPPORT_SUBJECT_PATTERN = /^[^\u0000-\u001f\u007f]*$/;
/** Retours à la ligne et tabulations admis ; autres caractères de contrôle refusés. */
export const SUPPORT_MESSAGE_PATTERN =
  // eslint-disable-next-line no-control-regex -- refuse volontairement les caractères de contrôle du message
  /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;
/** Chemin interne seul : ni schéma, ni hôte, ni requête (`?`), ni fragment (`#`). */
export const SUPPORT_PAGE_PATTERN = /^\/[A-Za-z0-9/_.\-[\]]*$/;
export const SUPPORT_APP_VERSION_PATTERN = /^[0-9A-Za-z.+-]+$/;

/**
 * 1-16C.1 — Seuls champs acceptés (`forbidNonWhitelisted` global) : toute
 * tentative d'imposer un utilisateur, une organisation, un e-mail, un rôle
 * ou un destinataire est refusée en 400. L'identité vient de la session et
 * de la base, jamais du corps.
 */
export class CreateSupportRequestDto {
  /** Généré UNE fois par intention côté client, stable sur les rejeux. */
  @IsUUID('4')
  requestId: string;

  @IsString()
  @IsIn(Object.keys(SUPPORT_CATEGORIES))
  category: SupportCategory;

  @IsString()
  @MaxLength(SUPPORT_SUBJECT_MAX_LENGTH)
  @Matches(SUPPORT_SUBJECT_PATTERN)
  subject: string;

  @IsString()
  @MaxLength(SUPPORT_MESSAGE_MAX_LENGTH)
  @Matches(SUPPORT_MESSAGE_PATTERN)
  message: string;

  @IsOptional()
  @IsString()
  @MaxLength(SUPPORT_PAGE_MAX_LENGTH)
  @Matches(SUPPORT_PAGE_PATTERN)
  page?: string;

  @IsOptional()
  @IsString()
  @MaxLength(SUPPORT_APP_VERSION_MAX_LENGTH)
  @Matches(SUPPORT_APP_VERSION_PATTERN)
  appVersion?: string;
}
