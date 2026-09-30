import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
  Type,
  mixin,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { Observable } from 'rxjs';

/**
 * 1-12D — Limites multipart DURCIES, appliquées à toutes les routes d'upload.
 *
 * Multer 2.4.0 corrige GHSA-535w-7cp7-47q4 (index de tableau démesuré dans
 * un nom de champ, CPU bloqué) et borne l'imbrication UNIQUEMENT si
 * l'application fournit ces limites : `fieldArrayIndexLimit` et
 * `fieldNestingDepth` valent `Infinity` par défaut (README Multer, section
 * « Security »). Sans elles, un seul corps multipart de quelques octets
 * (`items[4294967294]` puis `items[key]`) bloque le processus ~3 minutes.
 *
 * Aucun champ multipart de Stock Master n'utilise la notation à crochets
 * (champs plats des DTO produits/objets/branding) : profondeur 0 et index 0.
 * Options officielles de Multer uniquement — aucun parseur maison.
 */
export const HARDENED_MULTIPART_LIMITS = {
  fieldNameSize: 100,
  fields: 20,
  files: 1,
  fieldNestingDepth: 0,
  fieldArrayIndexLimit: 0,
} as const;

// Limites Multer 2.4.0 pas encore déclarées dans le typage Nest 11.2.6 —
// transmises telles quelles à Multer par `FileInterceptor`.
type MulterLimits = NonNullable<MulterOptions['limits']> & {
  fieldNestingDepth?: number;
  fieldArrayIndexLimit?: number;
};

/** Erreur Multer brute (codes sans correspondance dans Nest 11.2.6). */
function isMulterError(err: unknown): boolean {
  return err instanceof Error && err.name === 'MulterError';
}

/**
 * `FileInterceptor` Nest avec les limites durcies ci-dessus (les options
 * propres à la route — taille, `fileFilter` — sont conservées et priment
 * pour les clés qu'elles définissent). Toute erreur Multer que Nest 11.2.6
 * ne convertit pas (`LIMIT_FIELD_ARRAY_INDEX`, `INVALID_FIELD_NAME`,
 * `STREAM_DESTROYED`) devient un 400 stable au lieu d'un 500.
 */
export function SafeFileInterceptor(
  fieldName: string,
  options: MulterOptions = {},
): Type<NestInterceptor> {
  const limits: MulterLimits = {
    ...HARDENED_MULTIPART_LIMITS,
    ...options.limits,
  };
  const Base = FileInterceptor(fieldName, { ...options, limits });

  @Injectable()
  class SafeFileMixinInterceptor extends Base implements NestInterceptor {
    async intercept(
      context: ExecutionContext,
      next: CallHandler,
    ): Promise<Observable<unknown>> {
      try {
        return (await super.intercept(context, next)) as Observable<unknown>;
      } catch (err) {
        if (err instanceof HttpException) throw err;
        if (isMulterError(err)) {
          throw new BadRequestException({
            code: 'MULTIPART_INVALID',
            message: 'Requête multipart invalide.',
          });
        }
        throw err;
      }
    }
  }
  return mixin(SafeFileMixinInterceptor);
}
