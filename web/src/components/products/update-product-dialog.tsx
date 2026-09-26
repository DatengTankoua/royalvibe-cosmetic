"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fmtXof } from "@/lib/currency";
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
  const [name, setName] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [salePrice, setSalePrice] = useState("");
  const [additionalStock, setAdditionalStock] = useState("");
  const [loading, setLoading] = useState(false);
  const canEditAnything = canManageDescription || canAdjustStock;

  // Sync fields whenever the targeted product changes
  useEffect(() => {
    if (product) {
      setName(product.name);
      setPurchasePrice(String(product.purchasePrice));
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
      if (purchasePrice !== String(product.purchasePrice)) {
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
      toast.error("Aucune modification à enregistrer.");
      return;
    }

    setLoading(true);
    try {
      await onUpdated(product._id, payload);
      toast.success("Produit mis à jour");
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Modifier le produit</DialogTitle>
        </DialogHeader>
        {product && !canEditAnything && (
          <p className="text-sm text-muted-foreground">
            Tu n&apos;as pas la permission de modifier ce produit.
          </p>
        )}
        {product && canEditAnything && (
          <form onSubmit={handleSubmit} className="space-y-4 mt-2">
            {canManageDescription && (
              <div className="space-y-2">
                <Label htmlFor="u-name">Nom</Label>
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
                  <div className="space-y-2">
                    <Label htmlFor="u-buy">Prix d&apos;achat (FCFA)</Label>
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
                      Actuel : {fmtXof(product.purchasePrice)}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="u-sell">Prix de vente (FCFA)</Label>
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
                      Actuel : {fmtXof(product.salePrice)}
                    </p>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="u-stock">
                    Stock supplémentaire à ajouter
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
                    Stock restant : {product.remainingQuantity} · Vendu :{" "}
                    {product.unitsSold ?? 0}
                  </p>
                </div>
              </>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Mise à jour…" : "Enregistrer"}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
