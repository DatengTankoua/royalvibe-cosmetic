import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { extname } from 'path';
import sharp from 'sharp';

/**
 * Contrat du logo d'organisation (1-12C, étendu en 1-12D) — logo tenant
 * UNIQUEMENT, jamais les images produits. Formats : PNG, WebP statique,
 * JPEG (`.jpg`/`.jpeg`). Toute la validation a lieu AVANT le moindre appel
 * S3 ou écriture DB : un refus ne laisse aucune trace.
 *
 * Ordre : présence/non vide → taille (2 Mio) → extension → MIME déclaré →
 * signature réelle → cohérence → format détecté par Sharp → décodage
 * complet strict → dimensions ≤ 2048 × 2048 → une seule page/frame. Les
 * dimensions proviennent EXCLUSIVEMENT de Sharp (jamais d'une lecture
 * d'en-tête maison). Aucune transformation : l'image stockée est
 * l'octet-près celle reçue, seules sa clé et son `ContentType` sont
 * canoniques côté serveur (`.jpeg` → `.jpg`).
 *
 * Aucun effet de bord à l'import : la politique globale de Sharp (chargeurs
 * autorisés, cache) est appliquée UNE fois au bootstrap par
 * `common/image/sharp-security-policy.ts`, jamais ici ni par requête.
 */

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_MAX_DIMENSION = 2048;

/** Format tel que nommé par Sharp (`metadata().format`). */
export type LogoFormat = 'png' | 'webp' | 'jpeg';

export const LOGO_CONTENT_TYPES: Record<LogoFormat, string> = {
  png: 'image/png',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
};

/** Extension canonique de la clé S3 (`.jpeg` client → `.jpg`). */
export const LOGO_CANONICAL_EXTENSIONS: Record<LogoFormat, string> = {
  png: 'png',
  webp: 'webp',
  jpeg: 'jpg',
};

const EXTENSION_FORMAT: Record<string, LogoFormat> = {
  '.png': 'png',
  '.webp': 'webp',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
};
const MIME_FORMAT: Record<string, LogoFormat> = {
  'image/png': 'png',
  'image/webp': 'webp',
  'image/jpeg': 'jpeg',
};

// Signature PNG officielle complète (8 octets).
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

// Marqueur SOI JPEG + premier marqueur (FF D8 FF). Indice seulement : le
// fichier doit ensuite être réellement ouvert et décodé par Sharp.
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

export interface ValidatedLogo {
  format: LogoFormat;
  extension: string;
  contentType: string;
}

type LogoErrorCode =
  | 'LOGO_INVALID_FORMAT'
  | 'LOGO_TOO_LARGE'
  | 'LOGO_INVALID_DIMENSIONS'
  | 'LOGO_INVALID_FILE';

const MESSAGES: Record<LogoErrorCode, string> = {
  LOGO_INVALID_FORMAT: 'Le logo doit être une image PNG, WebP ou JPEG.',
  LOGO_TOO_LARGE: 'Le logo ne doit pas dépasser 2 Mo.',
  LOGO_INVALID_DIMENSIONS: `Le logo ne doit pas dépasser ${LOGO_MAX_DIMENSION} × ${LOGO_MAX_DIMENSION} pixels.`,
  LOGO_INVALID_FILE: 'Fichier image vide, corrompu ou illisible.',
};

/** 1-12D : logo animé ou multi-page (le logo tenant doit être statique). */
export const LOGO_NOT_STATIC_MESSAGE =
  'Le logo doit être une image PNG ou WebP statique valide.';

/** Erreur stable `{ code, message }` — jamais de détail interne. */
export function logoError(code: LogoErrorCode, message = MESSAGES[code]) {
  const body = { code, message };
  return code === 'LOGO_TOO_LARGE'
    ? new PayloadTooLargeException(body)
    : new BadRequestException(body);
}

/** Limite de pixels de Sharp dépassée (réutilisé par les photos produit). */
export function isPixelLimitError(err: unknown): boolean {
  return err instanceof Error && /exceeds pixel limit/i.test(err.message);
}

/** Signature réelle PNG / WebP / JPEG (réutilisé par les photos produit). */
export function detectSignature(buffer: Buffer): LogoFormat | null {
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
  if (
    buffer.length >= JPEG_SIGNATURE.length &&
    buffer.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)
  ) {
    return 'jpeg';
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
  // Contenu non PNG/WebP/JPEG (texte, SVG, GIF, AVIF… déguisés) : falsifié.
  if (!bySignature) throw logoError('LOGO_INVALID_FILE');
  // PNG renommé .jpg, WebP renommé .jpeg, MIME contradictoire, polyglotte
  // dont les déclarations ne concordent pas… : incohérence déclarée.
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
  if (detected !== 'png' && detected !== 'webp' && detected !== 'jpeg') {
    throw logoError('LOGO_INVALID_FORMAT');
  }
  if (detected !== bySignature) throw logoError('LOGO_INVALID_FORMAT');

  // Décodage COMPLET et strict de tous les pixels (`stats` parcourt l'image
  // entière) sans produire ni conserver de nouvelle image : un fichier dont
  // l'en-tête est valide mais les données corrompues ou tronquées est refusé.
  try {
    await open().stats();
  } catch {
    throw logoError('LOGO_INVALID_FILE');
  }

  const { width, height } = metadata;
  if (!width || !height) throw logoError('LOGO_INVALID_FILE');
  if (width > LOGO_MAX_DIMENSION || height > LOGO_MAX_DIMENSION) {
    throw logoError('LOGO_INVALID_DIMENSIONS');
  }

  // 1-12D : logo STATIQUE uniquement. Plusieurs pages/frames (WebP animé,
  // multi-page) ou un minutage d'animation dans les métadonnées Sharp →
  // refus, avant tout appel S3/DB. Limite ACCEPTÉE : libvips 8.18 n'expose
  // pas l'animation APNG (`pages` absent) ; aucun parseur PNG maison, voir
  // docs/architecture/phase-1-12d-upload-dependency-security.md.
  if ((metadata.pages ?? 1) > 1 || (metadata.delay?.length ?? 0) > 1) {
    throw logoError('LOGO_INVALID_FILE', LOGO_NOT_STATIC_MESSAGE);
  }

  return {
    format: detected,
    extension: LOGO_CANONICAL_EXTENSIONS[detected],
    contentType: LOGO_CONTENT_TYPES[detected],
  };
}
