import Image from "next/image";

// 1-16B — Aperçu du produit sur l'accueil : deux VRAIES captures mobiles de
// l'application (écrans Analyse et Ventes), produites sur la stack de recette
// éphémère avec une boutique et des ventes FICTIVES — aucun contenu client.
// Procédure : docs/architecture/phase-1-16b-marketing-homepage.md.
// Images servies par l'optimiseur Next (formats modernes, tailles adaptées) :
// l'accueil n'est pas une page du mode hors ligne.
const CAPTURES = {
  analyse: {
    src: "/marketing/capture-analyse-mobile.png",
    alt: "Écran Analyse de Stock Master pour une boutique fictive : capital investi 324 500 FCFA, chiffre d'affaires 88 250 FCFA, bénéfice net 18 200 FCFA, marge moyenne 20,6 %, 76 unités vendues en 10 transactions.",
  },
  ventes: {
    src: "/marketing/capture-ventes-mobile.png",
    alt: "Écran Ventes de Stock Master : liste des ventes enregistrées avec le produit, la quantité, le prix, le total et le vendeur, données fictives.",
  },
} as const;

// Dimensions réelles des captures (390 × 844 px affichés, échelle 2).
const WIDTH = 780;
const HEIGHT = 1688;

function Phone({
  capture,
  className,
  priority = false,
}: {
  capture: keyof typeof CAPTURES;
  className?: string;
  priority?: boolean;
}) {
  const { src, alt } = CAPTURES[capture];
  return (
    <div
      className={`overflow-hidden rounded-[2rem] border-[6px] border-[#021a3a] bg-white shadow-[0_24px_48px_-16px_rgba(2,26,58,0.55)] ${className ?? ""}`}
    >
      <Image
        src={src}
        alt={alt}
        width={WIDTH}
        height={HEIGHT}
        priority={priority}
        sizes="(min-width: 1024px) 280px, 56vw"
        className="block h-auto w-full"
      />
    </div>
  );
}

export function ProductPreview() {
  return (
    <figure className="relative mx-auto w-full max-w-[26rem] lg:max-w-none">
      <div className="relative flex items-start justify-center">
        <Phone
          capture="ventes"
          className="relative z-0 mt-14 w-[48%] -mr-[10%] opacity-95 lg:mt-20 lg:w-[250px]"
        />
        <Phone
          capture="analyse"
          priority
          className="relative z-10 w-[56%] lg:w-[280px]"
        />
      </div>
      <figcaption className="mt-5 text-center text-sm text-white/80">
        Captures réelles de l&apos;application, avec une boutique et des ventes
        fictives.
      </figcaption>
    </figure>
  );
}
