// 1-17B — occupation du stockage de l'organisation (photos et logo).
//
// - `notifyStorageChanged()` : signal LOCAL (même onglet) émis après un
//   envoi, un remplacement ou une suppression réussis ; tout affichage monté
//   de l'occupation se relit via l'API. Les changements des collègues
//   arrivent par les signaux temps réel existants (produits, organisation).
// - `formatBytes` : unités DÉCIMALES (1 Mo = 1 000 000 octets), comme le
//   quota serveur (250 Mo = 250 000 000 octets).
// - Limites de confort côté client (le serveur valide le contenu réel).

export const STORAGE_CHANGED_EVENT = "stockmaster:storage-changed";

export function notifyStorageChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(STORAGE_CHANGED_EVENT));
}

/** Même limite que l'API (`PRODUCT_IMAGE_MAX_BYTES`, 5 Mio). */
export const PRODUCT_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const PRODUCT_PHOTO_ACCEPT = "image/jpeg,image/png,image/webp";
const PRODUCT_PHOTO_TYPES = new Set(PRODUCT_PHOTO_ACCEPT.split(","));

/** Pré-contrôle de confort ; `null` si le fichier peut être proposé. */
export function productPhotoProblem(
  file: Pick<File, "size" | "type">,
): "type" | "size" | null {
  if (!PRODUCT_PHOTO_TYPES.has(file.type)) return "type";
  if (file.size > PRODUCT_PHOTO_MAX_BYTES) return "size";
  return null;
}

const UNITS: Record<"fr" | "en", readonly string[]> = {
  fr: ["octets", "Ko", "Mo", "Go"],
  en: ["bytes", "KB", "MB", "GB"],
};

export function formatBytes(bytes: number, locale: string): string {
  const units = locale.startsWith("fr") ? UNITS.fr : UNITS.en;
  const value = Math.max(0, bytes);
  let index = 0;
  let scaled = value;
  while (scaled >= 1000 && index < units.length - 1) {
    scaled /= 1000;
    index += 1;
  }
  const digits = index === 0 || scaled >= 100 ? 0 : 1;
  const number = new Intl.NumberFormat(locale, {
    maximumFractionDigits: digits,
  }).format(scaled);
  return `${number} ${units[index]}`;
}

/** Part utilisée (0–1), réservations comprises. */
export function usageRatio(usage: {
  usedBytes: number;
  reservedBytes: number;
  limitBytes: number;
}): number {
  if (usage.limitBytes <= 0) return 1;
  return Math.min(
    1,
    Math.max(0, (usage.usedBytes + usage.reservedBytes) / usage.limitBytes),
  );
}
