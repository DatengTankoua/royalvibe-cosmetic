"use client";

import { useEffect, useRef, useState } from "react";
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

// "2025-03" → "mars 2025"
function monthLabel(period: string): string {
  const [year, month] = period.split("-");
  return new Date(Number(year), Number(month) - 1).toLocaleDateString("fr-FR", {
    month: "long",
    year: "numeric",
  });
}

function salesLabel(count: number): string {
  if (count === 0) return "aucune vente";
  return `${count} vente${count > 1 ? "s" : ""}`;
}

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
  const online = useOnlineStatus();
  const { unfinalizedCount } = useOfflineSales();
  const [months, setMonths] = useState<MonthlyHistoryMonths | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [month, setMonth] = useState("");
  const [busy, setBusy] = useState<MonthlyHistoryFormat | null>(null);
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);
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
        if (!cancelled) setLoadError(await describeMonthlyHistoryError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const selected = months?.months.find((m) => m.month === month);

  const handleDownload = async (format: MonthlyHistoryFormat) => {
    if (!months || !month || lock.current) return;
    lock.current = true;
    setBusy(format);
    setMessage(null);
    try {
      await downloadMonthlyHistory(month, format, months.filenamePrefix);
      setMessage({
        kind: "success",
        text: `Fichier ${FORMAT_LABEL[format]} de ${monthLabel(month)} téléchargé.`,
      });
    } catch (error) {
      setMessage({
        kind: "error",
        text: await describeMonthlyHistoryError(error),
      });
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
                Historique mensuel
              </h2>
              <p className="text-sm text-muted-foreground">
                Téléchargez toutes les ventes d&apos;un mois, avec un bilan et
                des récapitulatifs par produit et par vendeur.
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
                Réessayer
              </Button>
            </div>
          ) : !months ? (
            <p role="status" className="text-sm text-muted-foreground">
              Chargement des mois disponibles…
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <label className="flex min-w-0 flex-col gap-1 text-sm sm:w-72">
                  <span className="font-medium">Mois</span>
                  <select
                    value={month}
                    onChange={(e) => {
                      setMonth(e.target.value);
                      setMessage(null);
                    }}
                    disabled={busy !== null}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  >
                    {months.months.map((m) => (
                      <option key={m.month} value={m.month}>
                        {monthLabel(m.month)}
                        {m.month === months.currentMonth
                          ? " (en cours)"
                          : ""} — {salesLabel(m.salesCount)}
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
                        ? "Préparation…"
                        : `Télécharger en ${FORMAT_LABEL[format]}`}
                    </Button>
                  ))}
                </div>
              </div>

              {selected?.salesCount === 0 && (
                <p className="text-sm text-muted-foreground">
                  Aucune vente enregistrée pour ce mois : le fichier contiendra
                  seulement le bilan, à zéro.
                </p>
              )}
              {month === months.currentMonth && (
                <p className="text-sm text-muted-foreground">
                  Mois en cours : le fichier reflète la situation au moment du
                  téléchargement.
                </p>
              )}
              {!online && (
                <p role="status" className="text-sm text-muted-foreground">
                  Le téléchargement nécessite une connexion Internet.
                </p>
              )}
              <div aria-live="polite">
                {message && (
                  <p
                    role={message.kind === "error" ? "alert" : "status"}
                    className={
                      message.kind === "error"
                        ? "text-sm text-destructive"
                        : "text-sm text-green-700 dark:text-green-500"
                    }
                  >
                    {message.text}
                  </p>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Les ventes encore en attente de synchronisation sur un appareil
                ne figurent pas dans le rapport.
                {unfinalizedCount > 0 &&
                  ` Cet appareil en a ${unfinalizedCount} : synchronisez-les avant de télécharger.`}{" "}
                Dates et limites du mois : fuseau {months.timeZone}, comme dans
                les analyses.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
