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
  return (
    <Image
      src={src}
      alt="Stock Master"
      width={width}
      height={height}
      priority={priority}
      // h-auto/w-auto laisse le ratio (fixé par width/height ci-dessus)
      // piloter le rendu ; max-w-full évite tout débordement à 320px.
      className={`h-auto w-auto max-w-full shrink-0 object-contain ${className ?? ""}`.trim()}
    />
  );
}
