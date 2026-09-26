"use client";

import { useEffect, useState } from "react";
import { fetchSales, getApiErrorMessage, type ApiSale } from "@/lib/api";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import { hasPermission } from "@/lib/organization-permissions";
import { fmtXof } from "@/lib/currency";
import { Card, CardContent } from "@/components/ui/card";

const fmt = fmtXof;

// /app/sales (1-9D, ex "/sales") : `GET /sales` exige `sales.view_all` OU
// `sales.view_own` côté backend (403 sinon) — jamais d'appel si aucune des
// deux permissions n'est accordée, même si le lien de nav reste visible
// pour `sales.record` seul (enregistrement depuis la fiche produit).
export default function SalesPage() {
  const { authContext } = useOrganizationShell();
  const canViewAll = hasPermission(authContext, "sales.view_all");
  const canViewOwn = hasPermission(authContext, "sales.view_own");
  const canView = canViewAll || canViewOwn;
  const canRecordOnly = !canView && hasPermission(authContext, "sales.record");

  const [sales, setSales] = useState<ApiSale[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!authContext) return;
    if (!canView) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    fetchSales()
      .then(setSales)
      .catch((err) => setError(getApiErrorMessage(err)))
      .finally(() => setIsLoading(false));
  }, [authContext, canView, retryKey]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
      <h1 className="text-2xl font-semibold">
        {canViewAll ? "Toutes les ventes" : "Mes ventes"}
      </h1>

      {!authContext || (isLoading && canView) ? (
        <p className="text-sm text-muted-foreground">Chargement…</p>
      ) : null}

      {authContext && canRecordOnly && (
        <p className="text-sm text-muted-foreground">
          Tu peux enregistrer des ventes depuis la fiche d&apos;un produit. Tu
          n&apos;as pas la permission de consulter la liste des ventes.
        </p>
      )}

      {authContext && !canView && !canRecordOnly && (
        <p className="text-sm text-muted-foreground">
          Tu n&apos;as pas la permission de consulter les ventes.
        </p>
      )}

      {canView && !isLoading && error && (
        <div className="flex items-center gap-3">
          <p className="text-sm text-destructive">{error}</p>
          <button
            onClick={() => setRetryKey((k) => k + 1)}
            className="text-sm text-primary underline underline-offset-2 hover:no-underline"
          >
            Réessayer
          </button>
        </div>
      )}

      {canView && !isLoading && sales.length === 0 && !error && (
        <p className="text-sm text-muted-foreground">
          Aucune vente enregistrée.
        </p>
      )}

      {canView && !isLoading && sales.length > 0 && (
        <div className="space-y-2">
          {sales.map((s) => {
            const productName =
              s.productId && typeof s.productId === "object"
                ? s.productId.name
                : (s.productName ?? "—");
            const sellerName =
              s.sellerId && typeof s.sellerId === "object"
                ? s.sellerId.name
                : "—";
            return (
              <Card key={s._id}>
                <CardContent className="py-3 flex justify-between gap-4 text-sm">
                  <div>
                    <p className="font-semibold">{productName}</p>
                    <p className="text-xs text-muted-foreground">
                      Vendeur : {sellerName} ·{" "}
                      {new Date(s.createdAt).toLocaleString("fr-FR")}
                    </p>
                    {s.buyerName && (
                      <p className="text-xs text-muted-foreground">
                        Acheteur : {s.buyerName}
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
    </div>
  );
}
