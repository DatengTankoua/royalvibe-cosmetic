import sharp from 'sharp';

/**
 * 1-12D — Politique Sharp/libvips du PROCESSUS API (unique, explicite).
 *
 * S'applique à TOUT le processus API, pas seulement au logo : seuls les
 * chargeurs « buffer » PNG, WebP et JPEG restent actifs ; SVG, GIF, AVIF,
 * HEIF/HEIC, TIFF, BMP, ICO, JPEG XL, PDF… ne peuvent jamais atteindre
 * libvips. Une future fonctionnalité nécessitant un autre format devra
 * modifier EXPLICITEMENT cette allowlist (et ses tests).
 *
 * Appliquée une seule fois au bootstrap Nest (`SharpSecurityPolicyInitializer`,
 * `OnApplicationBootstrap`), donc avant que l'application accepte des
 * requêtes, y compris pour les applications créées par les tests E2E.
 * Aucun effet de bord à l'import de ce module ni de `logo-validation.ts`,
 * aucun changement de politique par requête.
 */
export const SHARP_ALLOWED_LOADERS = [
  'VipsForeignLoadPngBuffer',
  'VipsForeignLoadWebpBuffer',
  'VipsForeignLoadJpegBuffer',
] as const;

let configured = false;

/** Idempotente : seul le premier appel modifie la configuration de Sharp. */
export function configureSharpSecurityPolicy(): void {
  if (configured) return;
  // Aucun cache d'opérations libvips : rien d'un fichier validé n'est retenu.
  sharp.cache(false);
  // Tous les chargeurs bloqués, puis réactivation de l'allowlist uniquement
  // (API documentée de Sharp : `block` / `unblock`).
  sharp.block({ operation: ['VipsForeignLoad'] });
  sharp.unblock({ operation: [...SHARP_ALLOWED_LOADERS] });
  configured = true;
}

export function isSharpSecurityPolicyConfigured(): boolean {
  return configured;
}
