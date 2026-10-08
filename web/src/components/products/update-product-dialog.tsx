"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import { getApiErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ApiProduct } from "@/lib/api";

interface UpdateProductDialogProps {
  product: ApiProduct | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  // `products.manage` : nom (section/image pas encore éditables ici — aucun
  // champ correspondant dans ce formulaire, rien à borner tant qu'ils
  // n'existent pas ; à gater de la même façon le jour où ils sont ajoutés).
  canManageDescription: boolean;
  // `stock.adjust` : prix d'achat/vente + stock additionnel.
  canAdjustStock: boolean;
  onUpdated: (
    id: string,
    payload: {
      name?: string;
      purchasePrice?: number;
      salePrice?: number;
      additionalStock?: number;
    },
  ) => Promise<void>;
}

export function UpdateProductDialog({
  product,
  open,
  onOpenChange,
  canManageDescription,
  canAdjustStock,
  onUpdated,
}: UpdateProductDialogProps) {
  const { t } = useT("catalog");
  const format = useFormat();
  const [name, setName] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [salePrice, setSalePrice] = useState("");
  const [additionalStock, setAdditionalStock] = useState("");
  const [loading, setLoading] = useState(false);
  const canEditAnything = canManageDescription || canAdjustStock;
  // 1-12H : le prix d'achat n'est proposé que s'il est visible
  // (`products.view_financials`) — jamais saisi « à l'aveugle » ni prérempli
  // par une valeur inventée.
  const purchasePriceVisible = product?.purchasePrice !== undefined;

  // Sync fields whenever the targeted product changes
  useEffect(() => {
    if (product) {
      setName(product.name);
      setPurchasePrice(
        product.purchasePrice !== undefined
          ? String(product.purchasePrice)
          : "",
      );
      setSalePrice(String(product.salePrice));
      setAdditionalStock("");
    }
  }, [product]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!product) return;

    // Construction explicite du payload : un champ non autorisé n'est
    // JAMAIS ajouté, même si sa valeur locale est restée identique à
    // l'originale — la permission borne le payload avant tout diff.
    const payload: {
      name?: string;
      purchasePrice?: number;
      salePrice?: number;
      additionalStock?: number;
    } = {};
    if (canManageDescription && name !== product.name) {
      payload.name = name;
    }
    if (canAdjustStock) {
      if (
        product.purchasePrice !== undefined &&
        purchasePrice !== String(product.purchasePrice)
      ) {
        payload.purchasePrice = parseFloat(purchasePrice);
      }
      if (salePrice !== String(product.salePrice)) {
        payload.salePrice = parseFloat(salePrice);
      }
      const qty = parseInt(additionalStock, 10);
      if (!isNaN(qty) && qty > 0) {
        payload.additionalStock = qty;
      }
    }

    if (Object.keys(payload).length === 0) {
      toast.error(t("product.noChange"));
      return;
    }

    setLoading(true);
    try {
      await onUpdated(product._id, payload);
      toast.success(t("product.updated"));
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("product.updateTitle")}</DialogTitle>
        </DialogHeader>
        {product && !canEditAnything && (
          <p className="text-sm text-muted-foreground">
            {t("product.noPermission")}
          </p>
        )}
        {product && canEditAnything && (
          <form onSubmit={handleSubmit} className="space-y-4 mt-2">
            {canManageDescription && (
              <div className="space-y-2">
                <Label htmlFor="u-name">{t("product.nameShort")}</Label>
                <Input
                  id="u-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
            )}
            {canAdjustStock && (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {purchasePriceVisible && (
                    <div className="space-y-2">
                      <Label htmlFor="u-buy">
                        {t("product.purchasePrice")}
                      </Label>
                      <Input
                        id="u-buy"
                        type="number"
                        min="0"
                        step="1"
                        value={purchasePrice}
                        onChange={(e) => setPurchasePrice(e.target.value)}
                        required
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("product.current", {
                          amount: format.fcfa(product.purchasePrice ?? 0),
                        })}
                      </p>
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="u-sell">{t("product.salePrice")}</Label>
                    <Input
                      id="u-sell"
                      type="number"
                      min="0"
                      step="1"
                      value={salePrice}
                      onChange={(e) => setSalePrice(e.target.value)}
                      required
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("product.current", {
                        amount: format.fcfa(product.salePrice),
                      })}
                    </p>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="u-stock">
                    {t("product.additionalStock")}
                  </Label>
                  <Input
                    id="u-stock"
                    type="number"
                    min="1"
                    step="1"
                    value={additionalStock}
                    onChange={(e) => setAdditionalStock(e.target.value)}
                    placeholder="0"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("product.remaining", {
                      count: product.remainingQuantity,
                    })}
                    {product.unitsSold !== undefined &&
                      ` · ${t("product.sold", { count: product.unitsSold })}`}
                  </p>
                </div>
              </>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? t("updating") : t("actions.save")}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
