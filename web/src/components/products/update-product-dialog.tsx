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
  onUpdated: (
    id: string,
    payload: {
      name?: string;
      purchasePrice?: number;
      salePrice?: number;
      additionalStock?: number;
      newRemainingQuantity?: number;
    },
  ) => Promise<void>;
}

export function UpdateProductDialog({
  product,
  open,
  onOpenChange,
  onUpdated,
}: UpdateProductDialogProps) {
  const [name, setName] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [salePrice, setSalePrice] = useState("");
  const [remainingQuantity, setRemainingQuantity] = useState("");
  const [loading, setLoading] = useState(false);

  // Sync fields whenever the targeted product changes
  useEffect(() => {
    if (product) {
      setName(product.name);
      setPurchasePrice(String(product.purchasePrice));
      setSalePrice(String(product.salePrice));
      setRemainingQuantity(String(product.remainingQuantity));
    }
  }, [product]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!product) return;
    setLoading(true);
    try {
      const newRemaining = parseInt(remainingQuantity, 10);
      await onUpdated(product._id, {
        name: name !== product.name ? name : undefined,
        purchasePrice:
          purchasePrice !== String(product.purchasePrice)
            ? parseFloat(purchasePrice)
            : undefined,
        salePrice:
          salePrice !== String(product.salePrice)
            ? parseFloat(salePrice)
            : undefined,
        newRemainingQuantity:
          !isNaN(newRemaining) && newRemaining !== product.remainingQuantity
            ? newRemaining
            : undefined,
      });
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
        {product && (
          <form onSubmit={handleSubmit} className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label htmlFor="u-name">Nom</Label>
              <Input
                id="u-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
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
              <Label htmlFor="u-stock">Stock restant</Label>
              <Input
                id="u-stock"
                type="number"
                min="0"
                step="1"
                value={remainingQuantity}
                onChange={(e) => setRemainingQuantity(e.target.value)}
                required
              />
              <p className="text-xs text-muted-foreground">
                Stock initial : {product.initialQuantity} · Vendu :{" "}
                {product.unitsSold ?? 0}
              </p>
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Mise à jour…" : "Enregistrer"}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface UpdateProductDialogProps {
  product: ApiProduct | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
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
  onUpdated,
}: UpdateProductDialogProps) {
  const [name, setName] = useState(product?.name ?? "");
  const [purchasePrice, setPurchasePrice] = useState(
    String(product?.purchasePrice ?? ""),
  );
  const [salePrice, setSalePrice] = useState(String(product?.salePrice ?? ""));
  const [additionalStock, setAdditionalStock] = useState("");
  const [loading, setLoading] = useState(false);

  // Sync when product changes
  if (product && name === "" && product.name) setName(product.name);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!product) return;
    setLoading(true);
    try {
      await onUpdated(product._id, {
        name: name || undefined,
        purchasePrice: purchasePrice ? parseFloat(purchasePrice) : undefined,
        salePrice: salePrice ? parseFloat(salePrice) : undefined,
        additionalStock: additionalStock
          ? parseInt(additionalStock, 10)
          : undefined,
      });
      toast.success("Produit mis à jour");
      onOpenChange(false);
      setAdditionalStock("");
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
        {product && (
          <form onSubmit={handleSubmit} className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label htmlFor="u-name">Nom</Label>
              <Input
                id="u-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="u-buy">Prix achat (FCFA)</Label>
                <Input
                  id="u-buy"
                  type="number"
                  min="0"
                  step="1"
                  value={purchasePrice}
                  onChange={(e) => setPurchasePrice(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="u-sell">Prix vente (FCFA)</Label>
                <Input
                  id="u-sell"
                  type="number"
                  min="0"
                  step="1"
                  value={salePrice}
                  onChange={(e) => setSalePrice(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="u-stock">Stock supplémentaire à ajouter</Label>
              <Input
                id="u-stock"
                type="number"
                min="0"
                step="1"
                placeholder="0"
                value={additionalStock}
                onChange={(e) => setAdditionalStock(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Mise à jour…" : "Enregistrer"}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
