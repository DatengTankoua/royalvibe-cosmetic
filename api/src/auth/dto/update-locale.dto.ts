import { IsIn } from 'class-validator';
import { APP_LOCALES, type AppLocale } from '../../common/i18n/locale';

/** 1-16G : langue choisie par l'utilisateur (e-mails et notifications). */
export class UpdateLocaleDto {
  @IsIn(APP_LOCALES)
  locale: AppLocale;
}
