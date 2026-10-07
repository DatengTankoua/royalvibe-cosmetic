"use client";

import { useEffect, useRef, useState } from "react";
import { useMessage } from "@/i18n/use-message";
import { useAnalytics } from "./use-analytics";
import { DownloadIcon, FileSpreadsheetIcon, FileTextIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useOfflineSales } from "@/contexts/offline-sales-context";
import { useOnlineStatus } from "@/hooks/use-online-status";
import {
  describeMonthlyHistoryError,
  downloadMonthlyHistory,
  fetchMonthlyHistoryMonths,
  type MonthlyHistoryFormat,
  type MonthlyHistoryMonths,
} from "@/lib/monthly-history";

// Noms de format : identiques dans toutes les langues.
const FORMAT_LABEL: Record<MonthlyHistoryFormat, string> = {
  xlsx: "Excel",
  pdf: "PDF",
};

/**
 * 1-16D — choix d'un mois et téléchargement de son historique complet
 * (Excel ou PDF). Affiché seulement au propriétaire et à l'administrateur ;
 * l'API refuse de toute façon tout autre compte.
 */
export function MonthlyHistoryDownload() {
  const a = useAnalytics();
  const { t, monthLabel } = a;
  const salesLabel = (count: number) =>
    count === 0
      ? t("monthly.noSales")
      : t("monthly.salesCount", { count, n: a.number(count) });
  const online = useOnlineStatus();
  const { unfinalizedCount } = useOfflineSales();
  const [months, setMonths] = useState<MonthlyHistoryMonths | null>(null);
  const [loadError, setLoadError] = useMessage("analytics");
  const [reloadKey, setReloadKey] = useState(0);
  const [month, setMonth] = useState("");
  const [busy, setBusy] = useState<MonthlyHistoryFormat | null>(null);
  const [message, setMessageText] = useMessage("analytics");
  const [messageKind, setMessageKind] = useState<"error" | "success">(
    "success",
  );
  const lock = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetchMonthlyHistoryMonths()
      .then((data) => {
        if (cancelled) return;
        setMonths(data);
        setLoadError(null);
        // Par défaut : le dernier mois terminé, sinon le mois en cours.
        setMonth(
          (current) =>
            current ||
            data.months.find((m) => m.month !== data.currentMonth)?.month ||
            data.currentMonth,
        );
      })
      .catch(async (error: unknown) => {
        const described = await describeMonthlyHistoryError(error);
        if (!cancelled) setLoadError(described);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, setLoadError]);

  const selected = months?.months.find((m) => m.month === month);

  const handleDownload = async (format: MonthlyHistoryFormat) => {
    if (!months || !month || lock.current) return;
    lock.current = true;
    setBusy(format);
    setMessageText(null);
    try {
      await downloadMonthlyHistory(month, format, months.filenamePrefix);
      setMessageKind("success");
      const downloadedMonth = month;
      setMessageText((tr) =>
        tr("monthly.downloaded", {
          format: FORMAT_LABEL[format],
          month: monthLabel(downloadedMonth),
        }),
      );
    } catch (error) {
      setMessageKind("error");
      setMessageText(await describeMonthlyHistoryError(error));
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="monthly-history-title">
      <Card>
        <CardContent className="space-y-4 py-5">
          <div className="flex items-start gap-3">
            <DownloadIcon
              className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <div className="min-w-0">
              <h2 id="monthly-history-title" className="font-semibold">
                {t("monthly.title")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t("monthly.text")}
              </p>
            </div>
          </div>

          {loadError ? (
            <div role="alert" className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-destructive">{loadError}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setLoadError(null);
                  setReloadKey((k) => k + 1);
                }}
              >
                {t("retry")}
              </Button>
            </div>
          ) : !months ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t("monthly.loading")}
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <label className="flex min-w-0 flex-col gap-1 text-sm sm:w-72">
                  <span className="font-medium">{t("monthly.month")}</span>
                  <select
                    value={month}
                    onChange={(e) => {
                      setMonth(e.target.value);
                      setMessageText(null);
                    }}
                    disabled={busy !== null}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  >
                    {months.months.map((m) => (
                      <option key={m.month} value={m.month}>
                        {t("monthly.option", {
                          month: monthLabel(m.month),
                          inProgress:
                            m.month === months.currentMonth
                              ? t("monthly.inProgress")
                              : "",
                          sales: salesLabel(m.salesCount),
                        })}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex flex-wrap gap-2">
                  {(["xlsx", "pdf"] as const).map((format) => (
                    <Button
                      key={format}
                      type="button"
                      variant={format === "xlsx" ? "default" : "outline"}
                      disabled={!online || !month || busy !== null}
                      aria-busy={busy === format}
                      onClick={() => void handleDownload(format)}
                    >
                      {format === "xlsx" ? (
                        <FileSpreadsheetIcon
                          className="mr-1.5 h-4 w-4"
                          aria-hidden
                        />
                      ) : (
                        <FileTextIcon className="mr-1.5 h-4 w-4" aria-hidden />
                      )}
                      {busy === format
                        ? t("monthly.preparing")
                        : t("monthly.download", {
                            format: FORMAT_LABEL[format],
                          })}
                    </Button>
                  ))}
                </div>
              </div>

              {selected?.salesCount === 0 && (
                <p className="text-sm text-muted-foreground">
                  {t("monthly.emptyMonth")}
                </p>
              )}
              {month === months.currentMonth && (
                <p className="text-sm text-muted-foreground">
                  {t("monthly.currentMonth")}
                </p>
              )}
              {!online && (
                <p role="status" className="text-sm text-muted-foreground">
                  {t("monthly.offline")}
                </p>
              )}
              <div aria-live="polite">
                {message && (
                  <p
                    role={messageKind === "error" ? "alert" : "status"}
                    className={
                      messageKind === "error"
                        ? "text-sm text-destructive"
                        : "text-sm text-green-700 dark:text-green-500"
                    }
                  >
                    {message}
                  </p>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("monthly.pendingNote")}
                {unfinalizedCount > 0 &&
                  ` ${t("monthly.pendingDevice", {
                    count: unfinalizedCount,
                    n: a.number(unfinalizedCount),
                  })}`}{" "}
                {t("monthly.timeZone", { timeZone: months.timeZone })}
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
