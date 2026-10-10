"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ClockIcon } from "lucide-react";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import { fetchSalesPage, getApiErrorMessage, type SalesPage } from "@/lib/api";
import { useAuth } from "@/contexts/auth-context";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import {
  useOfflineSales,
  usePendingSalesHref,
} from "@/contexts/offline-sales-context";
import { PendingSalesAnchor } from "@/components/sales/pending-sales-nav";
import { hasPermission } from "@/lib/organization-permissions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useLiveRefresh, useSocketSignals } from "@/hooks/use-live-refresh";
import { SALE_INVALIDATION_EVENTS } from "@/hooks/use-sale-invalidation";
import { createResponseOrder } from "@/lib/refresh-coordinator";

// /app/sales (1-9D, ex "/sales") : l'historique exige `sales.view_all` OU
// `sales.view_own` côté backend (403 sinon) — jamais d'appel si aucune des
// deux permissions n'est accordée, même si le lien de nav reste visible
// pour `sales.record` seul (enregistrement depuis la fiche produit).
//
// 1-20E : historique PAGINÉ (`GET /sales/history`, curseur) — plus jamais
// tout l'historique. Le total vient du serveur (tout le périmètre autorisé).
// Les relectures temps réel, la confirmation d'une vente locale et le
// rattrapage après reconnexion relisent la SEULE page affichée. Pages
// stables : une vente ajoutée n'apparaît qu'en tête ; hors de la première
// page, un avis propose d'y revenir. Une page devenue vide (annulations)
// ramène à la page précédente. API antérieure : historique complet de
// l'ancien contrat, présenté comme complet (aucune pagination).
export default function SalesListPage() {
  const { t } = useT("sales");
  const format = useFormat();
  const fmt = format.fcfa;
  const { authContext } = useOrganizationShell();
  const canViewAll = hasPermission(authContext, "sales.view_all");
  const canViewOwn = hasPermission(authContext, "sales.view_own");
  const canView = canViewAll || canViewOwn;
  const canRecordOnly = !canView && hasPermission(authContext, "sales.record");

  const [page, setPage] = useState<SalesPage | null>(null);
  const sales = page?.items ?? [];
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  // 1-20E : curseur de chaque page visitée (page 0 : aucun curseur).
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [newerAvailable, setNewerAvailable] = useState(false);
  // 1-11C.3 : page relue après confirmation d'une vente locale.
  const { unfinalizedCount, syncedVersion } = useOfflineSales();
  const pendingLink = usePendingSalesHref();
  const { sessionVersion } = useAuth();
  // 1-15A : début de la dernière lecture réussie (rattrapage après
  // reconnexion) ; une réponse périmée n'écrase jamais une page plus récente.
  const [loadedAt, setLoadedAt] = useState<number | undefined>(undefined);
  const order = useRef(createResponseOrder());
  // 1-20E : vue demandée (session, organisation, périmètre, page, curseur) ;
  // une réponse d'une autre vue est ignorée.
  const scope = `${sessionVersion}:${authContext?.organizationId ?? ""}:${
    canViewAll ? "all" : canViewOwn ? "own" : "none"
  }`;
  const cursor = cursors[pageIndex] ?? null;
  const viewRef = useRef({ scope, pageIndex, cursor });
  useEffect(() => {
    viewRef.current = { scope, pageIndex, cursor };
  });
  const totalRef = useRef<number | null>(null);

  // Session, organisation ou permissions changées : retour à la page 1.
  useEffect(() => {
    viewRef.current = { scope, pageIndex: 0, cursor: null };
    setCursors([null]);
    setPageIndex(0);
    setPage(null);
    setNewerAvailable(false);
    totalRef.current = null;
  }, [scope]);

  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    const view = { ...viewRef.current };
    if (!options.silent) {
      setIsLoading(true);
      setError(null);
    }
    const requestedAt = Date.now();
    const ticket = order.current.begin();
    try {
      const data = await fetchSalesPage(view.cursor);
      const now = viewRef.current;
      if (
        now.scope !== view.scope ||
        now.pageIndex !== view.pageIndex ||
        now.cursor !== view.cursor
      ) {
        return;
      }
      if (!order.current.accept(ticket)) return;
      // Page devenue vide (annulations) : page précédente.
      if (data.items.length === 0 && view.pageIndex > 0) {
        setPageIndex(view.pageIndex - 1);
        return;
      }
      if (view.pageIndex === 0) {
        setNewerAvailable(false);
      } else if (totalRef.current !== null && data.total > totalRef.current) {
        setNewerAvailable(true);
      }
      totalRef.current = data.total;
      setPage(data);
      setCursors((prev) => {
        const next = prev.slice(0, view.pageIndex + 1);
        if (data.nextCursor) next.push(data.nextCursor);
        return next;
      });
      setError(null);
      setLoadedAt(requestedAt);
    } catch (err) {
      // Une relecture silencieuse en échec conserve la page affichée.
      if (!options.silent) setError(getApiErrorMessage(err));
    } finally {
      if (!options.silent) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authContext) return;
    if (!canView) {
      setIsLoading(false);
      return;
    }
    void load();
  }, [authContext, canView, retryKey, pageIndex, scope, load]);

  // 1-11C.3 : vente locale confirmée → page affichée relue (silencieuse).
  useEffect(() => {
    if (syncedVersion > 0 && canView) void load({ silent: true });
  }, [syncedVersion, canView, load]);

  // 1-15A : vente enregistrée, modifiée ou supprimée par n'importe quel
  // membre → page affichée relue silencieusement, regroupée (l'API applique
  // `view_own` / `view_all` : jamais la vente d'un collègue sans
  // `sales.view_all`). 1-20E : jamais les autres pages.
  const scheduleRefresh = useLiveRefresh(
    () => (canView ? load({ silent: true }) : Promise.resolve()),
    canView ? loadedAt : undefined,
  );
  useSocketSignals(SALE_INVALIDATION_EVENTS, scheduleRefresh);

  const hasNext = Boolean(page && !page.legacy && page.nextCursor);
  const goTo = (index: number) => {
    if (index === pageIndex) return;
    if (index === 0) setNewerAvailable(false);
    // Même rendu que le changement de page : jamais le numéro d'une page
    // avec les ventes ou les boutons de la précédente.
    setIsLoading(true);
    setPageIndex(index);
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">
          {canViewAll ? t("list.allTitle") : t("list.ownTitle")}
        </h1>
        {/* 1-11C.3 : accès permanent depuis la page ventes. */}
        <PendingSalesAnchor
          href={pendingLink.href}
          offline={pendingLink.offline}
          className="inline-flex items-center gap-1.5 self-start rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
        >
          <ClockIcon className="h-3.5 w-3.5" aria-hidden />
          {t("pendingOnDevice")}
          {unfinalizedCount > 0 && (
            <span className="rounded-full bg-destructive px-1.5 text-[10px] font-semibold text-destructive-foreground">
              {unfinalizedCount}
            </span>
          )}
        </PendingSalesAnchor>
      </div>

      {canView && newerAvailable && pageIndex > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm">
          <span>{t("list.page.newer")}</span>
          <Button variant="outline" size="sm" onClick={() => goTo(0)}>
            {t("list.page.showNewer")}
          </Button>
        </div>
      )}

      {!authContext || (isLoading && canView) ? (
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      ) : null}

      {authContext && canRecordOnly && (
        <p className="text-sm text-muted-foreground">{t("list.recordOnly")}</p>
      )}

      {authContext && !canView && !canRecordOnly && (
        <p className="text-sm text-muted-foreground">
          {t("list.noPermission")}
        </p>
      )}

      {canView && !isLoading && error && (
        <div className="flex items-center gap-3">
          <p className="text-sm text-destructive">{error}</p>
          <button
            onClick={() => setRetryKey((k) => k + 1)}
            className="text-sm text-primary underline underline-offset-2 hover:no-underline"
          >
            {t("actions.retry")}
          </button>
        </div>
      )}

      {canView && !isLoading && sales.length === 0 && !error && (
        <p className="text-sm text-muted-foreground">{t("list.empty")}</p>
      )}

      {canView && !isLoading && sales.length > 0 && (
        <div className="space-y-2">
          {sales.map((s) => {
            // 1-15D : nom ENREGISTRÉ à la vente d'abord (historique, même
            // après renommage) ; sinon nom actuel du produit, puis dernier
            // nom connu figé à sa suppression. Jamais de nom inventé.
            const product =
              s.productId && typeof s.productId === "object"
                ? s.productId
                : null;
            const productDeleted = s.productId === null;
            const productName =
              s.productName ?? product?.name ?? s.lastKnownProductName ?? null;
            const renamedTo =
              s.productName && product && product.name !== s.productName
                ? product.name
                : null;
            const nameNotRecorded = !s.productName && productName !== null;
            const sellerName =
              s.sellerId && typeof s.sellerId === "object"
                ? s.sellerId.name
                : "—";
            return (
              <Card key={s._id}>
                <CardContent className="py-3 flex justify-between gap-4 text-sm">
                  <div>
                    <p className="font-semibold">
                      {productName ?? (
                        <span className="italic text-muted-foreground">
                          {t("list.nameNotKept")}
                        </span>
                      )}
                    </p>
                    {(productDeleted || renamedTo || nameNotRecorded) && (
                      <p className="text-xs text-muted-foreground">
                        {productDeleted && (
                          <span className="mr-2 rounded bg-muted px-1.5 py-0.5 font-medium">
                            {t("list.productDeleted")}
                          </span>
                        )}
                        {nameNotRecorded && t("list.nameNotRecorded")}
                        {renamedTo && t("list.renamedTo", { name: renamedTo })}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {t("seller")} {sellerName} ·{" "}
                      {format.dateTime(s.createdAt)}
                    </p>
                    {s.buyerName && (
                      <p className="text-xs text-muted-foreground">
                        {t("buyer")} {s.buyerName}
                        {s.buyerContact ? ` — ${s.buyerContact}` : ""}
                      </p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-bold">
                      {s.quantity} × {fmt(s.salePrice)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      = {fmt(s.quantity * s.salePrice)}
                    </p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {canView && !isLoading && page && !error && (
        <nav
          aria-label={t("list.page.navLabel")}
          className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {page.legacy
              ? t("list.page.complete", { count: page.total })
              : t("list.page.summary", {
                  count: page.total,
                  page: pageIndex + 1,
                })}
          </p>
          {!page.legacy && (pageIndex > 0 || hasNext) && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={pageIndex === 0}
                onClick={() => goTo(0)}
              >
                {t("list.page.first")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={pageIndex === 0}
                onClick={() => goTo(pageIndex - 1)}
              >
                {t("list.page.previous")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!hasNext}
                onClick={() => goTo(pageIndex + 1)}
              >
                {t("list.page.next")}
              </Button>
            </div>
          )}
        </nav>
      )}
    </div>
  );
}
