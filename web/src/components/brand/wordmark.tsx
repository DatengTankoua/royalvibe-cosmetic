import Image from "next/image";

// Logo officiel Stock Master (1-11A) : image fournie, jamais redessinée ni
// remplacée par un SVG maison — voir web/scripts/generate-pwa-icons.ps1 et
// docs/architecture/phase-1-11a-pwa-foundation.md. Ratio figé (jamais étiré).
const SOURCES = {
  horizontal: {
    src: "/brand/stock-master-logo-horizontal.png",
    ratio: 2172 / 724,
  },
  icon: { src: "/brand/stock-master-icon.png", ratio: 1 },
} as const;

type WordmarkVariant = keyof typeof SOURCES;
type WordmarkSize = "small" | "medium" | "large";

// Tailles centralisées (correction visuelle 1-11A) : largeur cible en px par
// variante/taille ; la hauteur est toujours dérivée du ratio réel de
// l'image (jamais de valeur qui l'étirerait).
const SIZE_WIDTH: Record<WordmarkVariant, Record<WordmarkSize, number>> = {
  horizontal: { small: 140, medium: 180, large: 230 },
  icon: { small: 36, medium: 44, large: 56 },
};

export function Wordmark({
  className,
  variant = "horizontal",
  size = "medium",
  priority = false,
}: {
  className?: string;
  variant?: WordmarkVariant;
  size?: WordmarkSize;
  priority?: boolean;
}) {
  const { src, ratio } = SOURCES[variant];
  const width = SIZE_WIDTH[variant][size];
  const height = Math.round(width / ratio);
  // Correctif 1-11C.3a : conteneur aux dimensions explicites (largeur
  // centralisée + ratio réel). Sans lui, une image `unoptimized` (pas de
  // srcset) prendrait la taille naturelle du PNG source (2172 px de large).
  // max-w-full : réduction proportionnelle si l'espace manque (320 px).
  // 1-16F : en thème sombre, plaque blanche derrière le logo officiel
  // (navy sur fond clair) — jamais d'inversion ni de filtre sur l'image.
  return (
    <span
      className={`block max-w-full shrink-0 dark:rounded-md dark:bg-white ${className ?? ""}`.trim()}
      style={{ width, aspectRatio: `${width} / ${height}` }}
    >
      <Image
        src={src}
        alt="Stock Master"
        width={width}
        height={height}
        priority={priority}
        // Sert directement l'asset statique /brand/* (précaché par le service
        // worker) au lieu de /_next/image?url=…, URL dynamique jamais mise en
        // cache → logo cassé hors ligne. PNG sources haute résolution : rendu
        // net, y compris sur écran 2x/3x.
        unoptimized
        className="h-full w-full object-contain"
      />
    </span>
  );
}
