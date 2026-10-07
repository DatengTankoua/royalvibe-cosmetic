"use client";

import { useMemo, useState } from "react";
import { ChevronRightIcon, ClockIcon } from "lucide-react";
import { useT } from "next-i18next/client";
import { useAuth } from "@/contexts/auth-context";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import {
  useOfflineSales,
  usePendingSalesHref,
} from "@/contexts/offline-sales-context";
import { PendingSalesAnchor } from "@/components/sales/pending-sales-nav";
import { HomeQuickActions } from "@/components/dashboard/home-quick-actions";
import { CurrencyConverter } from "@/components/currency/currency-converter";
import { homeQuickActions } from "@/lib/home-quick-actions";
import { firstNameOf, fullNameOf } from "@/lib/display-names";

// Accueil du shell /app. Le garde d'authentification vit dans
// app/app/layout.tsx (shell partagé). 1-12A : le commerce est l'identité
// principale (nom/logo dans l'en-tête, couleur via --tenant-*). 1-12B :
// tableau d'accès rapides — aucune donnée ni appel réseau supplémentaire
// (contexte d'autorisation, statut hors ligne et compteur de ventes en
// attente déjà fournis par le shell), aucun chiffre ni graphique inventé.
// Hors ligne : le message unique du shell suffit (aucun second bandeau).
export default function AppHomePage() {
  const { t } = useT("catalog");
  const { t: tc } = useT("common");
  const { t: ts } = useT("sales");
  const { user } = useAuth();
  const { authContext } = useOrganizationShell();
  const { offline, unfinalizedCount } = useOfflineSales();
  const pendingLink = usePendingSalesHref();
  const [converterOpen, setConverterOpen] = useState(false);
  // Recalculé seulement quand le contexte d'autorisation change.
  const actions = useMemo(() => homeQuickActions(authContext), [authContext]);

  if (!user) return null;

  const pendingLabel = ts("nav.pendingCount", { count: unfinalizedCount });

  return (
    <div
      data-testid="app-home"
      className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6 sm:pt-10"
    >
      <section
        aria-labelledby="home-greeting"
        className="rounded-2xl border border-l-4 border-(--tenant-accent-border) border-l-(--tenant-accent) bg-(--tenant-accent-soft) px-5 py-5"
      >
        <h1
          id="home-greeting"
          className="truncate text-2xl font-semibold"
          title={fullNameOf(user.name) ?? undefined}
        >
          {t("home.greeting", {
            name: firstNameOf(user.name) ?? tc("shell.myAccount"),
          })}
        </h1>
        <p className="mt-1 text-sm text-foreground">{t("home.question")}</p>
      </section>

      {/* Ventes locales non finalisées de la partition courante : en ligne
      → /app/sales/pending ; hors ligne → panneau du catalogue (seule route
      /app servie hors ligne), via l'ancre existante. */}
      {unfinalizedCount > 0 && (
        <section aria-labelledby="home-pending">
          <h2 id="home-pending" className="sr-only">
            {ts("pendingPage.title")}
          </h2>
          <PendingSalesAnchor
            href={pendingLink.href}
            offline={pendingLink.offline}
            className="flex min-h-14 items-center gap-3 rounded-2xl border border-amber-500/40 bg-amber-50 px-4 py-3 text-amber-900 outline-none hover:bg-amber-100 dark:hover:bg-amber-500/20 focus-visible:ring-2 focus-visible:ring-(--tenant-accent-ring) focus-visible:ring-offset-2 motion-safe:transition-colors dark:bg-amber-500/10 dark:text-amber-200"
          >
            <span
              aria-hidden="true"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/20"
            >
              <ClockIcon className="h-5 w-5" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-semibold" data-testid="home-pending-count">
                {pendingLabel}
              </span>
              <span className="text-sm">
                {pendingLink.offline
                  ? t("home.pendingOffline")
                  : t("home.pendingOnline")}
              </span>
            </span>
            <ChevronRightIcon className="h-5 w-5 shrink-0" aria-hidden />
          </PendingSalesAnchor>
        </section>
      )}

      <section
        aria-labelledby="home-quick-actions"
        className="flex flex-col gap-3"
      >
        <h2 id="home-quick-actions" className="text-base font-semibold">
          {t("home.quickActions")}
        </h2>
        <HomeQuickActions
          actions={actions}
          offline={offline}
          onOpenConverter={() => setConverterOpen(true)}
        />
      </section>

      <CurrencyConverter open={converterOpen} onOpenChange={setConverterOpen} />
    </div>
  );
}
