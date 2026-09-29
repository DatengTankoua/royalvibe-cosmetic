// 1-12A — Couleur du commerce dans le shell /app.
//
// Point de calcul UNIQUE et pur (testable sans DOM) : la valeur
// `organization.brandColor` n'est jamais injectée telle quelle dans le CSS.
// Elle est validée (#RRGGBB strict), décomposée en entiers, et chaque jeton
// est ré-émis en `#rrggbb` formaté ici — aucune chaîne brute ne peut donc
// atteindre une déclaration CSS. Les pages publiques n'utilisent jamais ces
// jetons (variables posées uniquement sur la racine du shell).

import type { CSSProperties } from "react";

/** Couleur Stock Master (navy) : repli si la couleur est absente/invalide. */
export const DEFAULT_TENANT_BRAND_COLOR = "#062b5c";
const NAVY = "#062b5c";
const WHITE = "#ffffff";
/** WCAG 2.x AA, texte normal. */
export const AA_TEXT_CONTRAST = 4.5;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

type Rgb = readonly [number, number, number];

/** `#RRGGBB` strict → forme canonique minuscule, sinon `null`. */
export function normalizeBrandColor(value: unknown): string | null {
  if (typeof value !== "string" || !HEX_COLOR.test(value)) return null;
  return value.toLowerCase();
}

function toRgb(hex: string): Rgb {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b]
    .map((c) =>
      Math.max(0, Math.min(255, Math.round(c)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function linearChannel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = toRgb(hex);
  return (
    0.2126 * linearChannel(r) +
    0.7152 * linearChannel(g) +
    0.0722 * linearChannel(b)
  );
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Mélange linéaire sRGB : `t = 0` → `from`, `t = 1` → `to`. */
function mix(from: string, to: string, t: number): string {
  const a = toRgb(from);
  const b = toRgb(to);
  return toHex([
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ]);
}

/** Texte lisible sur `background` : navy ou blanc, le plus contrasté. */
export function readableForeground(background: string): string {
  return contrastRatio(background, NAVY) >= contrastRatio(background, WHITE)
    ? NAVY
    : WHITE;
}

/**
 * Assombrit `color` par pas de 5 % vers le noir jusqu'à satisfaire `ok`
 * (au pire noir, qui satisfait toujours les critères utilisés ici).
 */
function darkenUntil(color: string, ok: (c: string) => boolean): string {
  let current = color;
  for (let step = 1; step <= 20 && !ok(current); step++) {
    current = mix(color, "#000000", step * 0.05);
  }
  return current;
}

export interface TenantAccentTokens {
  /** Couleur validée du commerce (repli navy Stock Master). */
  brand: string;
  /** Fond plein des éléments porteurs de texte (pastille, CTA). */
  accent: string;
  /** Texte sur `accent` : navy ou blanc, contraste ≥ 4,5:1 garanti. */
  accentForeground: string;
  /** Fond léger (élément actif, cartes). */
  accentSoft: string;
  /** Bordures et filets décoratifs. */
  accentBorder: string;
  /** Accent utilisé comme couleur de TEXTE sur fond blanc/léger (≥ 4,5:1). */
  accentInk: string;
  /** Anneau de focus (non-texte, ≥ 3:1 sur fond blanc). */
  accentRing: string;
}

export function computeTenantAccent(brandColor: unknown): TenantAccentTokens {
  const brand = normalizeBrandColor(brandColor) ?? DEFAULT_TENANT_BRAND_COLOR;
  // Couleurs moyennes (ni navy ni blanc n'atteignent 4,5:1, pire cas
  // ≈ 3,7:1) : le fond est légèrement assombri, le texte devient blanc.
  const accent = darkenUntil(
    brand,
    (c) => contrastRatio(c, readableForeground(c)) >= AA_TEXT_CONTRAST,
  );
  const accentForeground = readableForeground(accent);
  const accentSoft = mix(brand, WHITE, 0.9);
  // Texte accentué lisible sur blanc ET sur le fond léger.
  const accentInk = darkenUntil(
    brand,
    (c) =>
      contrastRatio(c, WHITE) >= AA_TEXT_CONTRAST &&
      contrastRatio(c, accentSoft) >= AA_TEXT_CONTRAST,
  );
  return {
    brand,
    accent,
    accentForeground,
    accentSoft,
    accentBorder: mix(brand, WHITE, 0.6),
    accentInk,
    accentRing: accentInk,
  };
}

/** Variables CSS posées sur la racine du shell /app (jamais sur :root). */
export function tenantAccentStyle(tokens: TenantAccentTokens): CSSProperties {
  return {
    "--tenant-brand": tokens.brand,
    "--tenant-accent": tokens.accent,
    "--tenant-accent-foreground": tokens.accentForeground,
    "--tenant-accent-soft": tokens.accentSoft,
    "--tenant-accent-border": tokens.accentBorder,
    "--tenant-accent-ink": tokens.accentInk,
    "--tenant-accent-ring": tokens.accentRing,
  } as CSSProperties;
}
