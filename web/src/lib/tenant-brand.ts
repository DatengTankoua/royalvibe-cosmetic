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
 * Déplace `color` par pas de 5 % vers `target` (noir pour assombrir, blanc
 * pour éclaircir) jusqu'à satisfaire `ok` ; au pire `target`, qui satisfait
 * toujours les critères utilisés ici.
 */
function shiftUntil(
  color: string,
  target: string,
  ok: (c: string) => boolean,
): string {
  let current = color;
  for (let step = 1; step <= 20 && !ok(current); step++) {
    current = mix(color, target, step * 0.05);
  }
  return current;
}

const darkenUntil = (color: string, ok: (c: string) => boolean) =>
  shiftUntil(color, "#000000", ok);
const lightenUntil = (color: string, ok: (c: string) => boolean) =>
  shiftUntil(color, WHITE, ok);

// 1-16F : surfaces du thème sombre (globals.css, .dark) en sRGB —
// --background oklch(0.145) ≈ #0a0a0a, --card/--popover oklch(0.205)
// ≈ #171717, --muted oklch(0.269) ≈ #262626 (surface la plus claire sur
// laquelle un accent peut apparaître, survol compris).
export const DARK_BACKGROUND = "#0a0a0a";
export const DARK_SURFACE = "#171717";
export const DARK_MUTED = "#262626";
/** WCAG 2.x 1.4.11 : éléments graphiques et contours de contrôles. */
export const AA_NON_TEXT_CONTRAST = 3;
/** Filets décoratifs : simplement perceptibles (aucune exigence WCAG). */
const BORDER_VISIBILITY = 1.5;

export interface TenantAccentVariant {
  /** Fond plein des éléments porteurs de texte (pastille, CTA, barres). */
  accent: string;
  /** Texte sur `accent` : navy ou blanc, contraste ≥ 4,5:1 garanti. */
  accentForeground: string;
  /** Fond léger (élément actif, cartes). */
  accentSoft: string;
  /** Bordures et filets décoratifs. */
  accentBorder: string;
  /** Accent utilisé comme couleur de TEXTE sur les surfaces (≥ 4,5:1). */
  accentInk: string;
  /** Anneau de focus (non-texte, ≥ 3:1 sur les surfaces). */
  accentRing: string;
}

export interface TenantAccentTokens extends TenantAccentVariant {
  /** Couleur validée du commerce (repli navy Stock Master), jamais modifiée. */
  brand: string;
  /** 1-16F : mêmes rôles pour le thème sombre. Les champs de premier niveau
   *  restent la variante claire. */
  dark: TenantAccentVariant;
}

function lightVariant(brand: string): TenantAccentVariant {
  // Couleurs moyennes (ni navy ni blanc n'atteignent 4,5:1, pire cas
  // ≈ 3,7:1) : le fond est légèrement assombri, le texte devient blanc.
  // 1-16F : une couleur très claire est aussi assombrie jusqu'à 3:1 contre
  // le fond blanc (bouton/barre de graphique visibles).
  const accent = darkenUntil(
    brand,
    (c) =>
      contrastRatio(c, readableForeground(c)) >= AA_TEXT_CONTRAST &&
      contrastRatio(c, WHITE) >= AA_NON_TEXT_CONTRAST,
  );
  const accentSoft = mix(brand, WHITE, 0.9);
  // Texte accentué lisible sur blanc ET sur le fond léger.
  const accentInk = darkenUntil(
    brand,
    (c) =>
      contrastRatio(c, WHITE) >= AA_TEXT_CONTRAST &&
      contrastRatio(c, accentSoft) >= AA_TEXT_CONTRAST,
  );
  return {
    accent,
    accentForeground: readableForeground(accent),
    accentSoft,
    accentBorder: darkenUntil(
      mix(brand, WHITE, 0.6),
      (c) => contrastRatio(c, WHITE) >= BORDER_VISIBILITY,
    ),
    accentInk,
    accentRing: accentInk,
  };
}

function darkVariant(brand: string): TenantAccentVariant {
  // Couleur sombre (navy, noir…) : éclaircie jusqu'à 3:1 contre la carte
  // sombre ; couleur moyenne : éclaircie jusqu'à un texte navy à 4,5:1.
  const accent = lightenUntil(
    brand,
    (c) =>
      contrastRatio(c, readableForeground(c)) >= AA_TEXT_CONTRAST &&
      contrastRatio(c, DARK_SURFACE) >= AA_NON_TEXT_CONTRAST,
  );
  const accentSoft = mix(brand, DARK_BACKGROUND, 0.82);
  const accentInk = lightenUntil(
    brand,
    (c) =>
      contrastRatio(c, DARK_MUTED) >= AA_TEXT_CONTRAST &&
      contrastRatio(c, accentSoft) >= AA_TEXT_CONTRAST,
  );
  return {
    accent,
    accentForeground: readableForeground(accent),
    accentSoft,
    accentBorder: lightenUntil(
      mix(brand, DARK_BACKGROUND, 0.45),
      (c) => contrastRatio(c, DARK_BACKGROUND) >= BORDER_VISIBILITY,
    ),
    accentInk,
    accentRing: accentInk,
  };
}

export function computeTenantAccent(brandColor: unknown): TenantAccentTokens {
  const brand = normalizeBrandColor(brandColor) ?? DEFAULT_TENANT_BRAND_COLOR;
  return { brand, ...lightVariant(brand), dark: darkVariant(brand) };
}

function variantStyle(
  prefix: "light" | "dark",
  v: TenantAccentVariant,
): Record<string, string> {
  return {
    [`--tenant-${prefix}-accent`]: v.accent,
    [`--tenant-${prefix}-accent-foreground`]: v.accentForeground,
    [`--tenant-${prefix}-accent-soft`]: v.accentSoft,
    [`--tenant-${prefix}-accent-border`]: v.accentBorder,
    [`--tenant-${prefix}-accent-ink`]: v.accentInk,
    [`--tenant-${prefix}-accent-ring`]: v.accentRing,
  };
}

/**
 * Variables CSS posées sur la racine du shell /app (jamais sur :root).
 * 1-16F : les deux variantes sont posées ; globals.css associe
 * --tenant-accent* à l'une ou l'autre selon le thème affiché, sans
 * nouveau calcul ni rendu lors d'un changement de thème.
 */
export function tenantAccentStyle(tokens: TenantAccentTokens): CSSProperties {
  return {
    "--tenant-brand": tokens.brand,
    ...variantStyle("light", tokens),
    ...variantStyle("dark", tokens.dark),
  } as CSSProperties;
}
