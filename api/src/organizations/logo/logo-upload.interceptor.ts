import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
  Type,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Observable } from 'rxjs';
import { LOGO_MAX_BYTES, logoError } from './logo-validation';

// Multer arrête la lecture au-delà de 2 Mio (jamais un fichier plus gros
// entièrement bufferisé) et un seul fichier `logo`. Aucun `fileFilter` :
// le MIME déclaré n'est qu'une donnée parmi d'autres, contrôlée avec la
// signature et le décodage par `validateLogoFile`.
const BaseLogoFileInterceptor: Type<NestInterceptor> = FileInterceptor('logo', {
  limits: { fileSize: LOGO_MAX_BYTES, files: 1 },
});

/**
 * `FileInterceptor('logo')` dont le 413 générique de Multer
 * (`File too large`) devient l'erreur stable `LOGO_TOO_LARGE` (1-12C).
 */
@Injectable()
export class LogoUploadInterceptor
  extends BaseLogoFileInterceptor
  implements NestInterceptor
{
  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    try {
      return await super.intercept(context, next);
    } catch (err) {
      if (err instanceof PayloadTooLargeException) {
        throw logoError('LOGO_TOO_LARGE');
      }
      throw err;
    }
  }
}
