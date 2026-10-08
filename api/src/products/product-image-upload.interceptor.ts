import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
  Type,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { SafeFileInterceptor } from '../common/upload/safe-file-interceptor';
import {
  PRODUCT_IMAGE_MAX_BYTES,
  productImageError,
} from './product-image-validation';

// Multer arrête la lecture au-delà de 5 Mio (jamais un fichier plus gros
// entièrement bufferisé) ; un seul fichier `image`. Aucun `fileFilter` : le
// MIME déclaré n'est qu'une donnée parmi d'autres, contrôlée avec la
// signature et le décodage par `validateProductImage`.
const BaseProductImageInterceptor: Type<NestInterceptor> = SafeFileInterceptor(
  'image',
  { limits: { fileSize: PRODUCT_IMAGE_MAX_BYTES, files: 1 } },
);

/** Le 413 générique de Multer devient l'erreur stable `PRODUCT_IMAGE_TOO_LARGE`. */
@Injectable()
export class ProductImageUploadInterceptor
  extends BaseProductImageInterceptor
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
        throw productImageError('PRODUCT_IMAGE_TOO_LARGE');
      }
      throw err;
    }
  }
}
