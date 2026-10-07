import Link from "next/link";
import { PublicHeader } from "@/components/public/public-header";

// 1-16F — Page introuvable : en-tête public commun (contrôle du thème
// inclus) au lieu de la page par défaut, aux couleurs Stock Master.
export default function NotFound() {
  return (
    <div className="flex flex-1 flex-col bg-(--public-bg) text-(--brand-ink)">
      <PublicHeader />
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center">
        <p className="text-sm font-semibold text-(--public-muted)">
          Erreur 404
        </p>
        <h1 className="text-2xl font-bold text-balance">
          Cette page est introuvable
        </h1>
        <p className="text-(--public-muted)">
          Le lien est peut-être incomplet ou la page a été déplacée.
        </p>
        <Link
          href="/"
          className="inline-flex min-h-11 items-center justify-center rounded-lg bg-(--brand-solid) px-5 text-sm font-semibold text-white hover:bg-(--brand-solid)/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-ink)"
        >
          Retour à l&apos;accueil
        </Link>
      </div>
    </div>
  );
}
