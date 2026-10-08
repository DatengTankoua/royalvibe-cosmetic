"use client";

import Link from "next/link";
import { ClockIcon } from "lucide-react";
import { useT } from "next-i18next/client";
import {
  OFFLINE_SALES_PANEL_OPEN_EVENT,
  useOfflineSales,
  usePendingSalesHref,
} from "@/contexts/offline-sales-context";

// 1-11C.3 — Signalement des ventes locales non finalisées de la partition
// COURANTE. Rien n'est affiché quand la file est vide.

/**
 * Lien vers les ventes en attente. Hors ligne : ancre HTML simple vers
 * `/app/catalog#offline-sales-panel` (jamais `/app/sales/pending`, non servie
 * hors ligne) — navigation de fragment sur la même page, ou chargement du
 * document `/app/catalog` servi par le service worker. L'événement ouvre le
 * panneau même si le fragment est déjà présent dans l'URL.
 */
export function PendingSalesAnchor({
  href,
  offline,
  className,
  children,
  ...aria
}: {
  href: string;
  offline: boolean;
  className?: string;
  children: React.ReactNode;
  "aria-label"?: string;
  title?: string;
}) {
  if (!offline) {
    return (
      <Link href={href} prefetch={false} className={className} {...aria}>
        {children}
      </Link>
    );
  }
  return (
    <a
      href={href}
      className={className}
      {...aria}
      onClick={() =>
        window.dispatchEvent(new Event(OFFLINE_SALES_PANEL_OPEN_EVENT))
      }
    >
      {children}
    </a>
  );
}

export function PendingSalesHeaderLink() {
  const { t } = useT("sales");
  const { unfinalizedCount } = useOfflineSales();
  const { href, offline } = usePendingSalesHref();
  if (unfinalizedCount === 0) return null;
  const label = t("nav.pendingCount", { count: unfinalizedCount });
  return (
    <PendingSalesAnchor
      href={href}
      offline={offline}
      aria-label={label}
      title={label}
      className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-500/15 px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-500/25 dark:text-amber-300"
    >
      <ClockIcon className="h-3.5 w-3.5" aria-hidden />
      <span aria-hidden>{unfinalizedCount}</span>
      <span className="hidden lg:inline" aria-hidden>
        {t("nav.pendingShort")}
      </span>
    </PendingSalesAnchor>
  );
}

export function PendingSalesNavBadge() {
  const { t } = useT("sales");
  const { unfinalizedCount } = useOfflineSales();
  if (unfinalizedCount === 0) return null;
  return (
    <span className="rounded-full bg-destructive px-1.5 text-[10px] font-semibold leading-4 text-destructive-foreground">
      <span className="sr-only">{t("nav.pendingBadge")} </span>
      {unfinalizedCount}
    </span>
  );
}
