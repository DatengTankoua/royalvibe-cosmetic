"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { HardDriveIcon, RefreshCwIcon } from "lucide-react";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import { Button } from "@/components/ui/button";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { useLiveRefresh, useSocketSignals } from "@/hooks/use-live-refresh";
import { fetchStorageUsage, type ApiStorageUsage } from "@/lib/api";
import { createResponseOrder } from "@/lib/refresh-coordinator";
import {
  STORAGE_CHANGED_EVENT,
  formatBytes,
  usageRatio,
} from "@/lib/storage-usage";
import { STORAGE_USAGE_PERMISSIONS } from "@/lib/organization-permissions";

// 1-17B — signaux temps réel qui peuvent changer l'occupation (photo
// ajoutée, remplacée, purgée ; logo modifié). Le payload n'est jamais lu.
const STORAGE_SIGNALS = [
  "product:created",
  "product:updated",
  "product:purged",
  "organization:updated",
] as const;

// /app/organization/storage (1-17B) : occupation du stockage de
// l'organisation courante, lecture seule (aucune modification du quota).
// Visible avec `products.manage`, `branding.manage` ou `trash.manage` —
// aide UX ; l'API revérifie ces droits.
export default function OrganizationStoragePage() {
  const { t } = useT("organization");
  const { locale } = useFormat();
  const { authContext } = useOrganizationShell();
  const online = useOnlineStatus();
  const allowed = STORAGE_USAGE_PERMISSIONS.some((p) =>
    authContext?.effectivePermissions.includes(p),
  );
  const [usage, setUsage] = useState<ApiStorageUsage | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState<number | undefined>(undefined);
  const order = useRef(createResponseOrder());

  const load = useCallback(async () => {
    if (!allowed) return;
    const requestedAt = Date.now();
    const ticket = order.current.begin();
    try {
      const data = await fetchStorageUsage();
      if (!order.current.accept(ticket)) return;
      setUsage(data);
      setError(false);
      setLoadedAt(requestedAt);
    } catch {
      // Une relecture en échec conserve la dernière valeur affichée.
      if (order.current.accept(ticket)) setError(true);
    } finally {
      setLoading(false);
    }
  }, [allowed]);

  useEffect(() => {
    void load();
  }, [load]);

  const scheduleRefresh = useLiveRefresh(load, loadedAt);
  useSocketSignals(STORAGE_SIGNALS, scheduleRefresh);
  useEffect(() => {
    window.addEventListener(STORAGE_CHANGED_EVENT, scheduleRefresh);
    return () =>
      window.removeEventListener(STORAGE_CHANGED_EVENT, scheduleRefresh);
  }, [scheduleRefresh]);

  if (!allowed) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("errors.PERMISSION_DENIED")}
      </p>
    );
  }

  const ratio = usage ? usageRatio(usage) : 0;
  const full = usage ? usage.availableBytes === 0 : false;
  const fmt = (bytes: number) => formatBytes(bytes, locale);

  return (
    <div className="max-w-lg space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <HardDriveIcon className="h-5 w-5" aria-hidden />
            {t("storage.title")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("storage.text")}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={!online}
          aria-label={t("storage.refresh")}
        >
          <RefreshCwIcon className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      {!online && !usage && (
        <p className="text-sm text-muted-foreground">{t("storage.offline")}</p>
      )}
      {loading && online && !usage && (
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      )}
      {error && !usage && online && (
        <p role="alert" className="text-sm text-destructive">
          {t("storage.unavailable")}
        </p>
      )}

      {usage && (
        <div className="space-y-3 rounded-lg border p-4">
          <p className="text-base font-medium">
            {t("storage.used", {
              used: fmt(usage.usedBytes),
              limit: fmt(usage.limitBytes),
            })}
          </p>
          <div
            role="meter"
            aria-label={t("storage.title")}
            aria-valuemin={0}
            aria-valuemax={usage.limitBytes}
            aria-valuenow={Math.min(
              usage.limitBytes,
              usage.usedBytes + usage.reservedBytes,
            )}
            aria-valuetext={t("storage.used", {
              used: fmt(usage.usedBytes),
              limit: fmt(usage.limitBytes),
            })}
            className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className={`h-full rounded-full ${
                full
                  ? "bg-destructive"
                  : ratio >= 0.9
                    ? "bg-amber-500"
                    : "bg-(--tenant-accent,var(--primary))"
              }`}
              style={{ width: `${Math.round(ratio * 1000) / 10}%` }}
            />
          </div>
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span>
              {t("storage.available", { available: fmt(usage.availableBytes) })}
            </span>
            <span>{t("storage.files", { count: usage.storedObjects })}</span>
          </div>
          {usage.pendingUploads > 0 && (
            <p className="text-sm text-muted-foreground">
              {t("storage.pending", {
                count: usage.pendingUploads,
                size: fmt(usage.reservedBytes),
              })}
            </p>
          )}
          {usage.enforced && full && (
            <p role="status" className="text-sm text-destructive">
              {t("storage.full")}
            </p>
          )}
          {usage.enforced && !full && ratio >= 0.9 && (
            <p
              role="status"
              className="text-sm text-amber-700 dark:text-amber-400"
            >
              {t("storage.nearlyFull")}
            </p>
          )}
          {!usage.enforced && (
            <p className="text-sm text-muted-foreground">
              {t("storage.notEnforced")}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {t("storage.trashNote")}
          </p>
        </div>
      )}
    </div>
  );
}
