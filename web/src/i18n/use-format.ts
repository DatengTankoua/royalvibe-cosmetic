"use client";

import { useMemo } from "react";
import { fmtEur, fmtXof } from "@/lib/currency";
import {
  dateFormat,
  formatDate,
  formatDateTime,
  formatMonth,
  formatNumber,
} from "@/i18n/format";
import { useLocale } from "@/i18n/locale-provider";

/** Formats d'affichage liés à la langue courante (composants client). */
export function useFormat() {
  const { locale } = useLocale();
  return useMemo(
    () => ({
      locale,
      fcfa: (n: number) => fmtXof(n, locale),
      eur: (n: number) => fmtEur(n, locale),
      number: (n: number, options?: Intl.NumberFormatOptions) =>
        formatNumber(n, locale, options),
      date: (value: string | number | Date) => formatDate(value, locale),
      dateTime: (value: string | number | Date) =>
        formatDateTime(value, locale),
      month: (month: string) => formatMonth(month, locale),
      dateWith: (
        value: string | number | Date,
        options: Intl.DateTimeFormatOptions,
      ) => dateFormat(locale, options).format(new Date(value)),
    }),
    [locale],
  );
}
