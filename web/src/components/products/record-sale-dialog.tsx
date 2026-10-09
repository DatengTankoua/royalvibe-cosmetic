"use client";

import { useRef, useState } from "react";
import { ShoppingCartIcon, WifiOffIcon } from "lucide-react";
import { toast } from "sonner";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import { useMessage } from "@/i18n/use-message";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useIndicativeStock,
  useOfflineSales,
  usePendingSalesHref,
  type RecordSaleResult,
} from "@/contexts/offline-sales-context";
import { describeOperationError } from "@/lib/offline-sales-policy";
import { PendingSalesAnchor } from "@/components/sales/pending-sales-nav";

const TEXT_MAX = 100;

// 1-16G : messages dans `sales` (`form.refusal.*`), par raison de refus.
type RefusalReason = Extract<RecordSaleResult, { kind: "refused" }>["reason"];

export interface SaleFormInitial {
  quantity: number;
  salePrice: number;
  buyerName?: string;
  buyerContact?: string;
}

interface SaleFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: string;
  productName: string;
  targetPrice: number;
  // Stock connu (serveur ou snapshot). Absent : aucun plafond local, le
  // serveur tranche.
  remainingStock?: number;
  // Début de la requête serveur (ou écriture du snapshot) ayant fourni
  // `remainingStock` — voir `reservesStock`.
  serverLoadedAt?: number;
  initial?: SaleFormInitial;
  // Correction d'un conflit : NOUVELLE opération remplaçant celle-ci.
  replaces?: string;
  onSaleRecorded?: () => void;
  // 1-17B — élément qui reprend le focus à la fermeture (bouton « Vendre »
  // d'une carte) ; défaut : comportement du dialogue.
  finalFocus?: React.RefObject<HTMLElement | null>;
  // 1-17B — vente ACCEPTÉE (confirmée, en attente ou en conflit), appelé
  // juste avant la fermeture : distingue une fermeture après vente d'une
  // annulation (retour au détail du produit).
  onFinished?: () => void;
}

// 1-11C.3 — Formulaire UNIQUE (en ligne / hors ligne / correction) : toute
// vente passe par l'outbox (UUID et occurredAt figés à l'ajout), jamais par
// un POST /sales direct. « Vente enregistrée » n'est affiché qu'après
// confirmation serveur (synced) ; sinon la vente est signalée en attente.
export function SaleFormDialog({
  open,
  onOpenChange,
  productId,
  productName,
  targetPrice,
  remainingStock,
  serverLoadedAt,
  initial,
  replaces,
  onSaleRecorded,
  finalFocus,
  onFinished,
}: SaleFormDialogProps) {
  const { t } = useT("sales");
  const format = useFormat();
  const { online, canRecordSales, recordSale } = useOfflineSales();
  const indicative = useIndicativeStock(
    productId,
    remainingStock ?? 0,
    serverLoadedAt,
  );
  const pendingLink = usePendingSalesHref();
  const maxQuantity =
    remainingStock === undefined ? undefined : indicative.value;

  const [quantity, setQuantity] = useState(String(initial?.quantity ?? 1));
  const [salePrice, setSalePrice] = useState(
    String(initial?.salePrice ?? targetPrice),
  );
  const [buyerName, setBuyerName] = useState(initial?.buyerName ?? "");
  const [buyerContact, setBuyerContact] = useState(initial?.buyerContact ?? "");
  const [formError, setFormError] = useMessage("sales");
  // Refus « limite de 200 ventes » : lien vers les ventes en attente.
  const [limitReached, setLimitReached] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Garde synchrone : l'état React ne suffit pas contre un double clic.
  const submittingRef = useRef(false);

  const reset = () => {
    setQuantity("1");
    setSalePrice(String(targetPrice));
    setBuyerName("");
    setBuyerContact("");
    setFormError(null);
    setLimitReached(false);
  };

  const validate = (): {
    quantity: number;
    salePrice: number;
  } | null => {
    if (!/^\d+$/.test(quantity.trim()) || Number(quantity) < 1) {
      setFormError((tr) => tr("form.errors.quantity"));
      return null;
    }
    const q = Number(quantity);
    if (maxQuantity !== undefined && q > maxQuantity) {
      const hasReservation = indicative.hasReservation;
      setFormError((tr) =>
        hasReservation
          ? tr("form.errors.aboveIndicative", { max: maxQuantity })
          : tr("form.errors.aboveStock", { max: maxQuantity }),
      );
      return null;
    }
    const price = Number(salePrice);
    if (salePrice.trim() === "" || !Number.isFinite(price) || price < 0) {
      setFormError((tr) => tr("form.errors.price"));
      return null;
    }
    if (buyerName.length > TEXT_MAX || buyerContact.length > TEXT_MAX) {
      setFormError((tr) => tr("form.errors.buyerLength", { max: TEXT_MAX }));
      return null;
    }
    return { quantity: q, salePrice: price };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    setFormError(null);
    setLimitReached(false);
    const values = validate();
    if (!values) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const result = await recordSale(
        {
          productId,
          productName,
          unitPriceHint: targetPrice,
          quantity: values.quantity,
          salePrice: values.salePrice,
          buyerName: buyerName.trim() || undefined,
          buyerContact: buyerContact.trim() || undefined,
        },
        replaces ? { replaces } : undefined,
      );
      if (result.kind === "refused") {
        const reason: RefusalReason = result.reason;
        setLimitReached(reason === "limit");
        setFormError((tr) => tr(`form.refusal.${reason}`));
        return;
      }
      onFinished?.();
      onOpenChange(false);
      reset();
      if (result.kind === "synced") {
        toast.success(t("form.recorded"));
        onSaleRecorded?.();
      } else if (result.kind === "conflict") {
        const key = describeOperationError(result.operation.lastError);
        toast.error(t(`outbox.errors.${key ?? "refused"}`), {
          description: t("form.conflictHint"),
        });
      } else {
        toast.info(t("form.pending"), {
          description: t("form.pendingHint"),
        });
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !submitting && onOpenChange(v)}>
      <DialogContent finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>
            {replaces ? t("form.titleFix") : t("form.title")} — {productName}
          </DialogTitle>
          {!online && (
            <DialogDescription className="flex items-start gap-1.5">
              <WifiOffIcon
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                aria-hidden
              />
              {t("form.offline")}
            </DialogDescription>
          )}
        </DialogHeader>
        {!canRecordSales ? (
          <p role="alert" className="text-sm text-destructive">
            {t("form.refusal.capability")}
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="mt-2 space-y-4" noValidate>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="s-qty">{t("form.quantity")}</Label>
                <Input
                  id="s-qty"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  step="1"
                  max={maxQuantity}
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  required
                />
                {maxQuantity !== undefined && (
                  <p className="text-xs text-muted-foreground">
                    {indicative.hasReservation
                      ? t("form.indicativeStock", { count: maxQuantity })
                      : t("form.stock", { count: maxQuantity })}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="s-price">{t("form.actualPrice")}</Label>
                <Input
                  id="s-price"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="1"
                  value={salePrice}
                  onChange={(e) => setSalePrice(e.target.value)}
                  required
                />
                {salePrice && Number.isFinite(Number(salePrice)) && (
                  <p className="text-xs text-muted-foreground">
                    {t("form.total", {
                      amount: format.fcfa(
                        Number(salePrice) * (Number(quantity) || 1),
                      ),
                    })}
                  </p>
                )}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="s-buyer">{t("form.buyerName")}</Label>
              <Input
                id="s-buyer"
                maxLength={TEXT_MAX}
                value={buyerName}
                onChange={(e) => setBuyerName(e.target.value)}
                placeholder={t("form.buyerNamePlaceholder")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="s-contact">{t("form.buyerContact")}</Label>
              <Input
                id="s-contact"
                maxLength={TEXT_MAX}
                value={buyerContact}
                onChange={(e) => setBuyerContact(e.target.value)}
                placeholder={t("form.buyerContactPlaceholder")}
              />
            </div>
            {indicative.hasReservation && (
              <p className="text-xs text-muted-foreground">
                {t("form.indicativeNote")}
              </p>
            )}
            {formError && (
              <p role="alert" className="text-sm text-destructive">
                {formError}{" "}
                {limitReached && (
                  <PendingSalesAnchor
                    href={pendingLink.href}
                    offline={pendingLink.offline}
                  >
                    {t("form.seePending")}
                  </PendingSalesAnchor>
                )}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting
                ? online
                  ? t("form.sending")
                  : t("form.saving")
                : replaces
                  ? t("form.saveFix")
                  : t("form.confirm")}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface RecordSaleDialogProps {
  productId: string;
  productName: string;
  targetPrice: number;
  remainingStock: number;
  serverLoadedAt?: number;
  onSaleRecorded?: () => void;
}

export function RecordSaleDialog({
  productId,
  productName,
  targetPrice,
  remainingStock,
  serverLoadedAt,
  onSaleRecorded,
}: RecordSaleDialogProps) {
  const { t } = useT("sales");
  const [open, setOpen] = useState(false);
  const { canRecordSales } = useOfflineSales();
  const indicative = useIndicativeStock(
    productId,
    remainingStock,
    serverLoadedAt,
  );
  if (!canRecordSales) return null;
  return (
    <>
      <Button
        size="sm"
        onClick={() => setOpen(true)}
        disabled={indicative.value === 0}
      >
        <ShoppingCartIcon className="mr-1 h-4 w-4" />
        {t("form.record")}
      </Button>
      <SaleFormDialog
        open={open}
        onOpenChange={setOpen}
        productId={productId}
        productName={productName}
        targetPrice={targetPrice}
        remainingStock={remainingStock}
        serverLoadedAt={serverLoadedAt}
        onSaleRecorded={onSaleRecorded}
      />
    </>
  );
}
