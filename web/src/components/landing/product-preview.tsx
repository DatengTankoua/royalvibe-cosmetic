import Image from "next/image";
import { getServerT } from "@/i18n/server";

// 1-16B — Aperçu du produit sur l'accueil : deux VRAIES captures mobiles de
// l'application (écrans Analyse et Ventes), produites sur la stack de recette
// éphémère avec une boutique et des ventes FICTIVES — aucun contenu client.
// Procédure : docs/architecture/phase-1-16b-marketing-homepage.md.
// Images servies par l'optimiseur Next (formats modernes, tailles adaptées) :
// l'accueil n'est pas une page du mode hors ligne.
// 1-16G : les captures restent en français (images) ; leur texte
// alternatif suit la langue (`public` : `preview.*`).
const CAPTURES = {
  analyse: { src: "/marketing/capture-analyse-mobile.png" },
  ventes: { src: "/marketing/capture-ventes-mobile.png" },
} as const;

// Dimensions réelles des captures (390 × 844 px affichés, échelle 2).
const WIDTH = 780;
const HEIGHT = 1688;

function Phone({
  capture,
  alt,
  className,
  priority = false,
}: {
  capture: keyof typeof CAPTURES;
  alt: string;
  className?: string;
  priority?: boolean;
}) {
  const { src } = CAPTURES[capture];
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
  const { t } = await getServerT("public");
  return (
    <figure className="relative mx-auto w-full max-w-[26rem] lg:max-w-none">
      <div className="relative flex items-start justify-center">
        <Phone
          capture="ventes"
          alt={t("preview.salesAlt")}
          className="relative z-0 mt-14 w-[48%] -mr-[10%] opacity-95 lg:mt-20 lg:w-[250px]"
        />
        <Phone
          capture="analyse"
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
