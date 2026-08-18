"use client";

import { useState } from "react";
import { ShoppingCartIcon } from "lucide-react";
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
import { createSale, getApiErrorMessage } from "@/lib/api";
import { fmtXof } from "@/lib/currency";

interface RecordSaleDialogProps {
  productId: string;
  productName: string;
  targetPrice: number;
  remainingStock: number;
  onSaleRecorded?: () => void;
}

export function RecordSaleDialog({
  productId,
  productName,
  targetPrice,
  remainingStock,
  onSaleRecorded,
}: RecordSaleDialogProps) {
  const [open, setOpen] = useState(false);
  const [quantity, setQuantity] = useState("1");
  const [salePrice, setSalePrice] = useState(String(targetPrice));
  const [buyerName, setBuyerName] = useState("");
  const [buyerContact, setBuyerContact] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await createSale({
        productId,
        quantity: parseInt(quantity, 10),
        salePrice: parseFloat(salePrice),
        buyerName: buyerName || undefined,
        buyerContact: buyerContact || undefined,
      });
      toast.success("Vente enregistrée");
      setOpen(false);
      setQuantity("1");
      setBuyerName("");
      setBuyerContact("");
      onSaleRecorded?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        onClick={() => setOpen(true)}
        disabled={remainingStock === 0}
      >
        <ShoppingCartIcon className="mr-1 h-4 w-4" />
        Enregistrer une vente
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Vente — {productName}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4 mt-2">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="s-qty">Quantité</Label>
                <Input
                  id="s-qty"
                  type="number"
                  min="1"
                  max={remainingStock}
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Stock : {remainingStock}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="s-price">Prix de vente réel (FCFA)</Label>
                <Input
                  id="s-price"
                  type="number"
                  min="0"
                  step="1"
                  value={salePrice}
                  onChange={(e) => setSalePrice(e.target.value)}
                  required
                />
                {salePrice && !isNaN(parseFloat(salePrice)) && (
                  <p className="text-xs text-muted-foreground">
                    Total :{" "}
                    {fmtXof(
                      parseFloat(salePrice) * parseInt(quantity || "1", 10),
                    )}
                  </p>
                )}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="s-buyer">Nom acheteur (optionnel)</Label>
              <Input
                id="s-buyer"
                value={buyerName}
                onChange={(e) => setBuyerName(e.target.value)}
                placeholder="Prénom / Nom"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="s-contact">Contact acheteur (optionnel)</Label>
              <Input
                id="s-contact"
                value={buyerContact}
                onChange={(e) => setBuyerContact(e.target.value)}
                placeholder="Téléphone ou email"
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Enregistrement…" : "Confirmer la vente"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
