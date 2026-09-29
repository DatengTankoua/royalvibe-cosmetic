import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { extname } from 'path';
import sharp from 'sharp';

/**
 * Contrat du logo d'organisation (1-12C) — logo tenant UNIQUEMENT, jamais
 * les images produits. Toute la validation a lieu AVANT le moindre appel
 * S3 ou écriture DB : un refus ne laisse aucune trace.
 *
 * Ordre : présence/non vide → taille (2 Mio) → extension → MIME déclaré →
 * signature réelle → cohérence → métadonnées Sharp (format détecté,
 * dimensions ≤ 2048 × 2048) → décodage complet strict. Les dimensions
 * proviennent EXCLUSIVEMENT de Sharp (jamais d'une lecture d'en-tête
 * maison). Aucune transformation : l'image stockée est l'octet-près celle
 * reçue, seules sa clé et son `ContentType` sont canoniques côté serveur.
 */

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_MAX_DIMENSION = 2048;

export type LogoFormat = 'png' | 'webp';

export const LOGO_CONTENT_TYPES: Record<LogoFormat, string> = {
  png: 'image/png',
  webp: 'image/webp',
};

const EXTENSION_FORMAT: Record<string, LogoFormat> = {
  '.png': 'png',
  '.webp': 'webp',
};
const MIME_FORMAT: Record<string, LogoFormat> = {
  'image/png': 'png',
  'image/webp': 'webp',
};

// Signature PNG officielle complète (8 octets).
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

// Défense en profondeur (API documentée de Sharp) : seuls les chargeurs
// PNG et WebP depuis un Buffer restent actifs dans ce processus — un SVG,
// HEIF, TIFF, GIF… ne peut jamais atteindre libvips, même si un contrôle
// amont était contourné. Sharp n'est utilisé nulle part ailleurs dans l'API.
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({
  operation: ['VipsForeignLoadPngBuffer', 'VipsForeignLoadWebpBuffer'],
});
// Aucun cache d'opérations libvips : rien du fichier validé n'est retenu
// en mémoire après la validation.
sharp.cache(false);

export interface ValidatedLogo {
  format: LogoFormat;
  extension: LogoFormat;
  contentType: string;
}

type LogoErrorCode =
  | 'LOGO_INVALID_FORMAT'
  | 'LOGO_TOO_LARGE'
  | 'LOGO_INVALID_DIMENSIONS'
  | 'LOGO_INVALID_FILE';

const MESSAGES: Record<LogoErrorCode, string> = {
  LOGO_INVALID_FORMAT: 'Le logo doit être une image PNG ou WebP.',
  LOGO_TOO_LARGE: 'Le logo ne doit pas dépasser 2 Mo.',
  LOGO_INVALID_DIMENSIONS: `Le logo ne doit pas dépasser ${LOGO_MAX_DIMENSION} × ${LOGO_MAX_DIMENSION} pixels.`,
  LOGO_INVALID_FILE: 'Fichier image vide, corrompu ou illisible.',
};

/** Erreur stable `{ code, message }` — jamais de détail interne. */
export function logoError(code: LogoErrorCode) {
  const body = { code, message: MESSAGES[code] };
  return code === 'LOGO_TOO_LARGE'
    ? new PayloadTooLargeException(body)
    : new BadRequestException(body);
}

function isPixelLimitError(err: unknown): boolean {
  return err instanceof Error && /exceeds pixel limit/i.test(err.message);
}

function detectSignature(buffer: Buffer): LogoFormat | null {
  if (
    buffer.length >= PNG_SIGNATURE.length &&
    buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return 'png';
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('latin1', 0, 4) === 'RIFF' &&
    buffer.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

export async function validateLogoFile(
  file: Pick<
    Express.Multer.File,
    'buffer' | 'size' | 'originalname' | 'mimetype'
  >,
): Promise<ValidatedLogo> {
  const buffer = file.buffer;
  if (!buffer || buffer.length === 0 || file.size === 0) {
    throw logoError('LOGO_INVALID_FILE');
  }
  if (buffer.length > LOGO_MAX_BYTES) throw logoError('LOGO_TOO_LARGE');

  // `originalname` ne sert QU'À ce contrôle d'extension — jamais à la clé.
  const byExtension =
    EXTENSION_FORMAT[extname(file.originalname ?? '').toLowerCase()];
  const byMime = MIME_FORMAT[(file.mimetype ?? '').toLowerCase()];
  if (!byExtension || !byMime) throw logoError('LOGO_INVALID_FORMAT');

  const bySignature = detectSignature(buffer);
  // Contenu non PNG/WebP (texte, SVG, JPEG, GIF… déguisés) : fichier falsifié.
  if (!bySignature) throw logoError('LOGO_INVALID_FILE');
  // PNG renommé .webp, MIME contradictoire… : incohérence déclarée.
  if (byExtension !== bySignature || byMime !== bySignature) {
    throw logoError('LOGO_INVALID_FORMAT');
  }

  // Limite de pixels posée DÈS l'ouverture ; échec sur toute erreur OU
  // avertissement du décodeur (fichier tronqué, CRC invalide…).
  const open = () =>
    sharp(buffer, {
      limitInputPixels: LOGO_MAX_DIMENSION * LOGO_MAX_DIMENSION,
      failOn: 'warning',
    });

  let metadata: sharp.Metadata;
  try {
    metadata = await open().metadata();
  } catch (err) {
    // La limite de pixels s'applique dès la lecture des métadonnées : une
    // image au-delà de 2048 × 2048 pixels au total est refusée ici, avant
    // tout décodage (message documenté de Sharp, couvert par un test).
    throw logoError(
      isPixelLimitError(err) ? 'LOGO_INVALID_DIMENSIONS' : 'LOGO_INVALID_FILE',
    );
  }
  // Format détecté par Sharp à partir du CONTENU : png ou webp uniquement,
  // et identique à la signature, l'extension et le MIME déclarés.
  const detected = metadata.format;
  if (detected !== 'png' && detected !== 'webp') {
    throw logoError('LOGO_INVALID_FORMAT');
  }
  if (detected !== bySignature) throw logoError('LOGO_INVALID_FORMAT');

  const { width, height } = metadata;
  if (!width || !height) throw logoError('LOGO_INVALID_FILE');
  if (width > LOGO_MAX_DIMENSION || height > LOGO_MAX_DIMENSION) {
    throw logoError('LOGO_INVALID_DIMENSIONS');
  }

  // Décodage COMPLET de tous les pixels (`stats` parcourt l'image entière)
  // sans produire ni conserver de nouvelle image : un fichier dont
  // l'en-tête est valide mais les données corrompues est refusé ici.
  try {
    await open().stats();
  } catch {
    throw logoError('LOGO_INVALID_FILE');
  }

  return {
    format: detected,
    extension: detected,
    contentType: LOGO_CONTENT_TYPES[detected],
  };
}
