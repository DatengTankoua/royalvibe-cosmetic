"use client";

import { useMemo } from "react";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";

/**
 * 1-16G — Textes (namespace `analytics`) et formats d'affichage de la page
 * Analyse, dans la langue courante. Affichage seulement : aucune valeur
 * n'est recalculée (les arrondis restent ceux du lot 1-16E).
 */
export function useAnalytics() {
  const { t } = useT("analytics");
  const format = useFormat();
  return useMemo(() => {
    const number = (n: number) => format.number(n);
    const decimal = (n: number) =>
      format.number(n, { maximumFractionDigits: 1 });
    return {
      t,
      locale: format.locale,
      fcfa: format.fcfa,
      number,
      decimal,
      /** Jours estimés : 1 décimale sous 10 jours, entier au-delà. */
      formatDays: (days: number) =>
        days < 10 ? decimal(days) : number(Math.floor(days)),
      formatShortDate: (value: string | Date) =>
        format.dateWith(value, { day: "numeric", month: "short" }),
      formatDateTime: (value: string | Date) =>
        format.dateWith(value, {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        }),
      formatTime: (value: string | Date) =>
        format.dateWith(value, { hour: "2-digit", minute: "2-digit" }),
      monthLabel: (period: string) => format.month(period),
    };
  }, [t, format]);
}

export type AnalyticsFormat = ReturnType<typeof useAnalytics>;
