"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchSales, getApiErrorMessage, type ApiSale } from "@/lib/api";
import { useAuth } from "@/contexts/auth-context";
import { fmtXof } from "@/lib/currency";
import { Card, CardContent } from "@/components/ui/card";

const fmt = fmtXof;

export default function SalesPage() {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const [sales, setSales] = useState<ApiSale[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) router.push("/auth/login");
  }, [user, authLoading, router]);

  useEffect(() => {
    if (!user) return;
    fetchSales()
      .then(setSales)
      .catch((err) => setError(getApiErrorMessage(err)))
      .finally(() => setIsLoading(false));
  }, [user]);

  if (authLoading || !user) return null;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
      <h1 className="text-2xl font-semibold">Toutes les ventes</h1>

      {isLoading && (
        <p className="text-sm text-muted-foreground">Chargement…</p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {!isLoading && sales.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Aucune vente enregistrée.
        </p>
      )}

      {!isLoading && sales.length > 0 && (
        <div className="space-y-2">
          {sales.map((s) => {
            const productName =
              typeof s.productId === "object" ? s.productId.name : "—";
            const sellerName =
              typeof s.sellerId === "object" ? s.sellerId.name : "—";
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
