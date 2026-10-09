/**
 * 1-17B — Configuration SERVEUR des quotas de stockage (variables de
 * l'API ; aucune route ne permet à une organisation de la modifier).
 *
 * - `STORAGE_QUOTA_BYTES` : quota par organisation, en octets. Défaut
 *   250 000 000 (250 Mo décimaux).
 * - `STORAGE_QUOTA_MODE` : `enforce` (défaut) bloque un envoi qui
 *   dépasserait le quota ; `track` comptabilise sans bloquer (phase
 *   d'initialisation des fichiers existants, voir le rapport 1-17B).
 * - `STORAGE_RESERVATION_TTL_SECONDS` : durée d'une réservation (60–3600,
 *   défaut 900). L'envoi est annulé côté client S3 au tiers de cette durée ;
 *   la reprise ne traite une réservation qu'après son échéance.
 * - `STORAGE_RECOVERY_INTERVAL_SECONDS` : période de la reprise automatique
 *   dans le processus HTTP (0 = désactivée ; 60–86400 ; défaut 600).
 * - `STORAGE_INVENTORY_INTERVAL_SECONDS` : période de l'inventaire du
 *   stockage (fichiers présents sans entrée au registre : envoi arrivé après
 *   la reprise, ancien code…) dans le processus HTTP (0 = désactivé ;
 *   300–604800 ; défaut 21600 = 6 h).
 *
 * Toute valeur invalide est une erreur fatale au démarrage.
 */
export const DEFAULT_STORAGE_QUOTA_BYTES = 250_000_000;
export const DEFAULT_RESERVATION_TTL_SECONDS = 900;
export const DEFAULT_RECOVERY_INTERVAL_SECONDS = 600;
export const DEFAULT_INVENTORY_INTERVAL_SECONDS = 21_600;

export type StorageQuotaMode = 'enforce' | 'track';

export interface StorageQuotaConfig {
  quotaBytes: number;
  mode: StorageQuotaMode;
  reservationTtlSeconds: number;
  recoveryIntervalSeconds: number;
  inventoryIntervalSeconds: number;
}

export class StorageQuotaConfigError extends Error {}

function parseInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  allowZero = false,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const trimmed = value.trim();
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (allowZero && parsed === 0) return 0;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new StorageQuotaConfigError(
      `${name} doit être un entier entre ${min} et ${max}${allowZero ? ' (ou 0)' : ''}`,
    );
  }
  return parsed;
}

export function parseStorageQuotaConfig(
  env: Record<string, string | undefined>,
): StorageQuotaConfig {
  const mode = (env.STORAGE_QUOTA_MODE ?? '').trim() || 'enforce';
  if (mode !== 'enforce' && mode !== 'track') {
    throw new StorageQuotaConfigError(
      'STORAGE_QUOTA_MODE doit valoir enforce ou track',
    );
  }
  return {
    quotaBytes: parseInteger(
      'STORAGE_QUOTA_BYTES',
      env.STORAGE_QUOTA_BYTES,
      DEFAULT_STORAGE_QUOTA_BYTES,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    mode,
    reservationTtlSeconds: parseInteger(
      'STORAGE_RESERVATION_TTL_SECONDS',
      env.STORAGE_RESERVATION_TTL_SECONDS,
      DEFAULT_RESERVATION_TTL_SECONDS,
      60,
      3600,
    ),
    recoveryIntervalSeconds: parseInteger(
      'STORAGE_RECOVERY_INTERVAL_SECONDS',
      env.STORAGE_RECOVERY_INTERVAL_SECONDS,
      DEFAULT_RECOVERY_INTERVAL_SECONDS,
      60,
      86_400,
      true,
    ),
    inventoryIntervalSeconds: parseInteger(
      'STORAGE_INVENTORY_INTERVAL_SECONDS',
      env.STORAGE_INVENTORY_INTERVAL_SECONDS,
      DEFAULT_INVENTORY_INTERVAL_SECONDS,
      300,
      604_800,
      true,
    ),
  };
}
