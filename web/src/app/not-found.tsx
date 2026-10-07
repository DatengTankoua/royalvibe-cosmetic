import Link from "next/link";
import { PublicHeader } from "@/components/public/public-header";
import { getServerT } from "@/i18n/server";

// 1-16F — Page introuvable : en-tête public commun (contrôle du thème
// inclus) au lieu de la page par défaut, aux couleurs Stock Master.
export default async function NotFound() {
  const { t } = await getServerT("common");
  return (
    <div className="flex flex-1 flex-col bg-(--public-bg) text-(--brand-ink)">
      <PublicHeader />
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center">
        <p className="text-sm font-semibold text-(--public-muted)">
          {t("notFound.code")}
        </p>
        <h1 className="text-2xl font-bold text-balance">
          {t("notFound.title")}
        </h1>
        <p className="text-(--public-muted)">{t("notFound.text")}</p>
        <Link
          href="/"
          className="inline-flex min-h-11 items-center justify-center rounded-lg bg-(--brand-solid) px-5 text-sm font-semibold text-white hover:bg-(--brand-solid)/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-ink)"
        >
          {t("backToHome")}
        </Link>
      </div>
    </div>
  );
}
