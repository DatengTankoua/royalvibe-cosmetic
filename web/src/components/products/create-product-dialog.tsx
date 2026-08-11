"use client";

import { useState } from "react";
import axios from "axios";
import { ArrowLeftRightIcon, PlusIcon } from "lucide-react";
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
import { EUR_TO_XOF, fmtEur } from "@/lib/currency";
import { CurrencyConverter } from "@/components/currency/currency-converter";
import {
  DuplicateWarningDialog,
  type DuplicateItem,
} from "@/components/ui/duplicate-warning-dialog";

interface CreateProductDialogProps {
  sectionId: string;
  onCreated: (payload: {
    sectionId: string;
    name: string;
    purchasePrice: number;
    salePrice: number;
    initialQuantity: number;
    image: File;
  }) => Promise<void>;
}

export function CreateProductDialog({
  sectionId,
  onCreated,
}: CreateProductDialogProps) {
  const [open, setOpen] = useState(false);
  const [converterOpen, setConverterOpen] = useState(false);
  const [name, setName] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [salePrice, setSalePrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [duplicate, setDuplicate] = useState<DuplicateItem | null>(null);

  const resetForm = () => {
    setName("");
    setPurchasePrice("");
    setSalePrice("");
    setQuantity("");
    setImage(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!image) {
      toast.error("Photo requise");
      return;
    }
    setLoading(true);
    try {
      await onCreated({
        sectionId,
        name,
        purchasePrice: parseFloat(purchasePrice),
        salePrice: parseFloat(salePrice),
        initialQuantity: parseInt(quantity, 10),
        image,
      });
      toast.success("Produit ajouté");
      setOpen(false);
      resetForm();
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        const body = err.response.data as {
          message: string;
          existing: DuplicateItem & { sectionId: string };
        };
        if (body.message === "DUPLICATE_PRODUCT") {
          setOpen(false);
          setDuplicate(body.existing);
          return;
        }
      }
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <PlusIcon className="mr-1 h-4 w-4" />
        Ajouter un produit
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between">
              Nouveau produit
              <button
                type="button"
                onClick={() => setConverterOpen(true)}
                className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground hover:text-foreground transition-colors rounded px-2 py-1 hover:bg-muted"
              >
                <ArrowLeftRightIcon className="h-3 w-3" />
                EUR ↔ CFA
              </button>
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label htmlFor="p-name">Nom du produit</Label>
              <Input
                id="p-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="p-buy">Prix d&apos;achat (FCFA)</Label>
                <Input
                  id="p-buy"
                  type="number"
                  min="0"
                  step="1"
                  value={purchasePrice}
                  onChange={(e) => setPurchasePrice(e.target.value)}
                  required
                />
                {purchasePrice && !isNaN(parseFloat(purchasePrice)) && (
                  <p className="text-xs text-muted-foreground">
                    ≈ {fmtEur(parseFloat(purchasePrice) / EUR_TO_XOF)}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="p-sell">Prix de vente (FCFA)</Label>
                <Input
                  id="p-sell"
                  type="number"
                  min="0"
                  step="1"
                  value={salePrice}
                  onChange={(e) => setSalePrice(e.target.value)}
                  required
                />
                {salePrice && !isNaN(parseFloat(salePrice)) && (
                  <p className="text-xs text-muted-foreground">
                    ≈ {fmtEur(parseFloat(salePrice) / EUR_TO_XOF)}
                  </p>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground bg-muted rounded px-2 py-1">
              💡 Entrez les prix en FCFA. Cliquez sur <strong>EUR ↔ CFA</strong>{" "}
              en haut pour convertir.
            </p>
            <div className="space-y-2">
              <Label htmlFor="p-qty">Quantité initiale</Label>
              <Input
                id="p-qty"
                type="number"
                min="1"
                step="1"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="p-img">Photo du produit</Label>
              <Input
                id="p-img"
                type="file"
                accept="image/*"
                onChange={(e) => setImage(e.target.files?.[0] ?? null)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Enregistrement…" : "Ajouter"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <CurrencyConverter open={converterOpen} onOpenChange={setConverterOpen} />
      <DuplicateWarningDialog
        type="product"
        item={duplicate}
        onClose={() => setDuplicate(null)}
      />
    </>
  );
}
