import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import sharp from 'sharp';
import {
  detectSignature,
  isPixelLimitError,
  LOGO_CANONICAL_EXTENSIONS,
  LOGO_CONTENT_TYPES,
  type LogoFormat,
} from '../organizations/logo/logo-validation';

/**
 * Contrôle RÉEL d'une photo produit (R2), sur le modèle du logo (1-12C) :
 * jamais sur le seul MIME déclaré. Formats acceptés : JPEG, PNG, WebP
 * statiques. Ordre : présence → taille (5 Mio) → MIME déclaré → signature
 * réelle → cohérence → format détecté par Sharp → décodage complet strict →
 * dimensions → une seule image. Aucune transformation : les octets reçus
 * sont stockés, avec une clé et un `ContentType` canoniques côté serveur.
 * Le nom du fichier client n'est jamais utilisé.
 *
 * La politique globale de Sharp (chargeurs, cache) est appliquée au
 * bootstrap (`common/image/sharp-security-policy.ts`).
 */

export const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Côté maximal (pixels) d'une photo produit. */
export const PRODUCT_IMAGE_MAX_DIMENSION = 6000;
/** Surface maximale décodée (24 mégapixels), posée dès l'ouverture. */
export const PRODUCT_IMAGE_MAX_PIXELS = 24_000_000;

const MIME_FORMAT: Record<string, LogoFormat> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface ValidatedProductImage {
  format: LogoFormat;
  extension: string;
  contentType: string;
}

const ERRORS = {
  PRODUCT_IMAGE_INVALID_FORMAT: {
    code: 'PRODUCT_IMAGE_INVALID_FORMAT',
    message: 'La photo doit être une image JPEG, PNG ou WebP.',
  },
  PRODUCT_IMAGE_TOO_LARGE: {
    code: 'PRODUCT_IMAGE_TOO_LARGE',
    message: 'La photo ne doit pas dépasser 5 Mo.',
  },
  PRODUCT_IMAGE_INVALID_DIMENSIONS: {
    code: 'PRODUCT_IMAGE_INVALID_DIMENSIONS',
    message:
      'La photo ne doit pas dépasser 6000 pixels de côté ni 24 mégapixels.',
  },
  PRODUCT_IMAGE_INVALID_FILE: {
    code: 'PRODUCT_IMAGE_INVALID_FILE',
    message: 'Photo vide, corrompue, animée ou illisible.',
  },
} as const;

export type ProductImageErrorCode = keyof typeof ERRORS;

/** Erreur stable `{ code, message }` — jamais de détail interne. */
export function productImageError(code: ProductImageErrorCode) {
  const body = { ...ERRORS[code] };
  return code === 'PRODUCT_IMAGE_TOO_LARGE'
    ? new PayloadTooLargeException(body)
    : new BadRequestException(body);
}

export async function validateProductImage(
  file: Pick<Express.Multer.File, 'buffer' | 'size' | 'mimetype'>,
): Promise<ValidatedProductImage> {
  const buffer = file.buffer;
  if (!buffer || buffer.length === 0 || file.size === 0) {
    throw productImageError('PRODUCT_IMAGE_INVALID_FILE');
  }
  if (buffer.length > PRODUCT_IMAGE_MAX_BYTES) {
    throw productImageError('PRODUCT_IMAGE_TOO_LARGE');
  }

  const byMime = MIME_FORMAT[(file.mimetype ?? '').toLowerCase()];
  if (!byMime) throw productImageError('PRODUCT_IMAGE_INVALID_FORMAT');

  // Contenu non JPEG/PNG/WebP (texte, SVG, HTML, GIF, HEIC… déguisés).
  const bySignature = detectSignature(buffer);
  if (!bySignature) throw productImageError('PRODUCT_IMAGE_INVALID_FILE');
  if (byMime !== bySignature) {
    throw productImageError('PRODUCT_IMAGE_INVALID_FORMAT');
  }

  const open = () =>
    sharp(buffer, {
      limitInputPixels: PRODUCT_IMAGE_MAX_PIXELS,
      failOn: 'warning',
    });

  let metadata: sharp.Metadata;
  try {
    metadata = await open().metadata();
  } catch (err) {
    throw productImageError(
      isPixelLimitError(err)
        ? 'PRODUCT_IMAGE_INVALID_DIMENSIONS'
        : 'PRODUCT_IMAGE_INVALID_FILE',
    );
  }
  const detected = metadata.format;
  if (detected !== 'png' && detected !== 'webp' && detected !== 'jpeg') {
    throw productImageError('PRODUCT_IMAGE_INVALID_FORMAT');
  }
  if (detected !== bySignature) {
    throw productImageError('PRODUCT_IMAGE_INVALID_FORMAT');
  }

  // Décodage COMPLET et strict de tous les pixels, sans produire d'image.
  try {
    await open().stats();
  } catch (err) {
    throw productImageError(
      isPixelLimitError(err)
        ? 'PRODUCT_IMAGE_INVALID_DIMENSIONS'
        : 'PRODUCT_IMAGE_INVALID_FILE',
    );
  }

  const { width, height } = metadata;
  if (!width || !height) throw productImageError('PRODUCT_IMAGE_INVALID_FILE');
  if (
    width > PRODUCT_IMAGE_MAX_DIMENSION ||
    height > PRODUCT_IMAGE_MAX_DIMENSION
  ) {
    throw productImageError('PRODUCT_IMAGE_INVALID_DIMENSIONS');
  }
  // Une seule image : WebP animé ou multi-page refusé.
  if ((metadata.pages ?? 1) > 1 || (metadata.delay?.length ?? 0) > 1) {
    throw productImageError('PRODUCT_IMAGE_INVALID_FILE');
  }

  return {
    format: detected,
    extension: LOGO_CANONICAL_EXTENSIONS[detected],
    contentType: LOGO_CONTENT_TYPES[detected],
  };
}
