// 1-12A — Formatage d'AFFICHAGE uniquement (shell /app) : les valeurs
// stockées (utilisateur, organisation) ne sont jamais modifiées ; le nom
// complet reste disponible via `title`/texte accessible côté composant.

export const USER_NAME_FALLBACK = "Mon compte";
export const ORGANIZATION_NAME_FALLBACK = "Mon commerce";

function words(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .trim()
    .split(/\s+/u)
    .filter((w) => w.length > 0);
}

/** Premier segment non vide après trim, sinon un libellé neutre. */
export function firstNameOf(fullName: unknown): string {
  return words(fullName)[0] ?? USER_NAME_FALLBACK;
}

/** Nom complet nettoyé des espaces superflus (pour `title`). */
export function fullNameOf(value: unknown): string | null {
  const w = words(value);
  return w.length > 0 ? w.join(" ") : null;
}

function firstGrapheme(word: string): string {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segment = new Intl.Segmenter("fr", { granularity: "grapheme" })
      .segment(word)
      [Symbol.iterator]()
      .next();
    if (!segment.done) return segment.value.segment;
  }
  return Array.from(word)[0] ?? "";
}

/**
 * Initiales (1 à 2) d'une organisation : première lettre/chiffre des deux
 * premiers mots qui en commencent un (« Épicerie du Coin » → « ÉD »).
 */
export function organizationInitials(name: unknown): string {
  const initials = words(name)
    .map(firstGrapheme)
    .filter((g) => /^[\p{L}\p{N}]/u.test(g))
    .slice(0, 2)
    .join("");
  return initials.toLocaleUpperCase("fr-FR");
}
