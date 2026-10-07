"use client";

import { useEffect, useState } from "react";
import { Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  updateSale,
  deleteSale,
  getApiErrorMessage,
  type ApiSale,
} from "@/lib/api";

interface EditSaleDialogProps {
  sale: ApiSale | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onUpdated: () => void;
  onDeleted: () => void;
}

export function EditSaleDialog({
  sale,
  open,
  onOpenChange,
  onUpdated,
  onDeleted,
}: EditSaleDialogProps) {
  const { t } = useT("sales");
  const format = useFormat();
  const [quantity, setQuantity] = useState("");
  const [salePrice, setSalePrice] = useState("");
  const [loading, setLoading] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  useEffect(() => {
    if (sale) {
      setQuantity(String(sale.quantity));
      setSalePrice(String(sale.salePrice));
    }
  }, [sale]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sale) return;
    setLoading(true);
    try {
      await updateSale(sale._id, {
        quantity: parseInt(quantity, 10),
        salePrice: parseFloat(salePrice),
      });
      toast.success(t("edit.updated"));
      onOpenChange(false);
      onUpdated();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!sale) return;
    setDeleteLoading(true);
    try {
      await deleteSale(sale._id);
      toast.success(t("edit.deleted"));
      setDeleteOpen(false);
      onOpenChange(false);
      onDeleted();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setDeleteLoading(false);
    }
  };

  const qty = parseInt(quantity || "1", 10);
  const price = parseFloat(salePrice || "0");
  const total = !isNaN(qty) && !isNaN(price) ? qty * price : 0;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("edit.title")}</DialogTitle>
          </DialogHeader>
          {sale && (
            <form onSubmit={handleSubmit} className="space-y-4 mt-2">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="es-qty">{t("form.quantity")}</Label>
                  <Input
                    id="es-qty"
                    type="number"
                    min="1"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="es-price">{t("edit.price")}</Label>
                  <Input
                    id="es-price"
                    type="number"
                    min="0"
                    step="1"
                    value={salePrice}
                    onChange={(e) => setSalePrice(e.target.value)}
                    required
                  />
                  {total > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t("form.total", { amount: format.fcfa(total) })}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 pt-1">
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2Icon className="mr-1 h-4 w-4" />
                  {t("actions.delete")}
                </Button>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => onOpenChange(false)}
                  >
                    {t("actions.cancel")}
                  </Button>
                  <Button type="submit" disabled={loading}>
                    {loading ? t("form.saving") : t("actions.save")}
                  </Button>
                </div>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("edit.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("edit.deleteText")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteLoading}
            >
              {deleteLoading ? t("edit.deleting") : t("actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
