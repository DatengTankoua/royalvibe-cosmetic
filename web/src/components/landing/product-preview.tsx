import Image from "next/image";
import { getServerT } from "@/i18n/server";

// 1-16B/1-16H — Aperçu du produit sur l'accueil : deux VRAIES captures mobiles
// de l'application (écrans Analyse « Vos ventes » et Ventes), produites sur
// la stack de recette éphémère avec une boutique, des produits et des ventes
// FICTIFS — aucun contenu client. Procédure :
// docs/architecture/phase-1-16h-stock-master-brand-cleanup.md (§ 1.2).
// Images servies par l'optimiseur Next (formats modernes, tailles adaptées) :
// l'accueil n'est pas une page du mode hors ligne.
// 1-16H : une paire de captures par langue — les mêmes écrans réels, interface
// en français (« Boutique Démo ») ou en anglais (« Demo Shop »).
const CAPTURES = {
  fr: {
    analyse: "/marketing/capture-analyse-ventes-mobile-fr.png",
    ventes: "/marketing/capture-ventes-mobile-fr.png",
  },
  en: {
    analyse: "/marketing/capture-analytics-sales-mobile-en.png",
    ventes: "/marketing/capture-sales-mobile-en.png",
  },
} as const;

// Dimensions réelles des captures (390 × 844 px affichés, échelle 2).
const WIDTH = 780;
const HEIGHT = 1688;

function Phone({
  src,
  alt,
  className,
  priority = false,
}: {
  src: string;
  alt: string;
  className?: string;
  priority?: boolean;
}) {
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

export async function ProductPreview() {
  const { t, lng } = await getServerT("public");
  const captures = CAPTURES[lng];
  return (
    <figure className="relative mx-auto w-full max-w-[26rem] lg:max-w-none">
      <div className="relative flex items-start justify-center">
        <Phone
          src={captures.ventes}
          alt={t("preview.salesAlt")}
          className="relative z-0 mt-14 w-[48%] -mr-[10%] opacity-95 lg:mt-20 lg:w-[250px]"
        />
        <Phone
          src={captures.analyse}
          alt={t("preview.analyticsAlt")}
          priority
          className="relative z-10 w-[56%] lg:w-[280px]"
        />
      </div>
      <figcaption className="mt-5 text-center text-sm text-white/80">
        {t("preview.caption")}
      </figcaption>
    </figure>
  );
}
