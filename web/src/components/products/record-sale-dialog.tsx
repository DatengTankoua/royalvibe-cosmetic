"use client";

import { useRef, useState } from "react";
import { ShoppingCartIcon, WifiOffIcon } from "lucide-react";
import { toast } from "sonner";
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
import { fmtXof } from "@/lib/currency";
import { describeOperationError } from "@/lib/offline-sales-policy";
import { PendingSalesAnchor } from "@/components/sales/pending-sales-nav";

const TEXT_MAX = 100;
const PENDING_MESSAGE =
  "Vente enregistrée sur cet appareil, en attente de synchronisation";

const REFUSAL_MESSAGES: Record<
  Extract<RecordSaleResult, { kind: "refused" }>["reason"],
  string
> = {
  capability: "Saisie de vente non autorisée sur cet appareil.",
  identity: "Session non vérifiée sur cet appareil : reconnecte-toi.",
  invalid: "Données de vente invalides.",
  limit:
    "Limite de 200 ventes en attente atteinte : synchronise-les avant d'en saisir d'autres.",
  unavailable: "Stockage local indisponible : vente non enregistrée.",
  "not-replaceable": "Cette vente ne peut plus être corrigée.",
};

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
}: SaleFormDialogProps) {
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
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Garde synchrone : l'état React ne suffit pas contre un double clic.
  const submittingRef = useRef(false);

  const reset = () => {
    setQuantity("1");
    setSalePrice(String(targetPrice));
    setBuyerName("");
    setBuyerContact("");
    setFormError(null);
  };

  const validate = (): {
    quantity: number;
    salePrice: number;
  } | null => {
    if (!/^\d+$/.test(quantity.trim()) || Number(quantity) < 1) {
      setFormError("La quantité doit être un entier supérieur ou égal à 1.");
      return null;
    }
    const q = Number(quantity);
    if (maxQuantity !== undefined && q > maxQuantity) {
      setFormError(
        `Quantité supérieure au stock ${indicative.hasReservation ? "indicatif" : "disponible"} (${maxQuantity}).`,
      );
      return null;
    }
    const price = Number(salePrice);
    if (salePrice.trim() === "" || !Number.isFinite(price) || price < 0) {
      setFormError("Le prix doit être un nombre positif ou nul.");
      return null;
    }
    if (buyerName.length > TEXT_MAX || buyerContact.length > TEXT_MAX) {
      setFormError("Nom et contact : 100 caractères maximum.");
      return null;
    }
    return { quantity: q, salePrice: price };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    setFormError(null);
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
        setFormError(REFUSAL_MESSAGES[result.reason]);
        return;
      }
      onOpenChange(false);
      reset();
      if (result.kind === "synced") {
        toast.success("Vente enregistrée");
        onSaleRecorded?.();
      } else if (result.kind === "conflict") {
        toast.error(
          describeOperationError(result.operation.lastError) ??
            "Vente refusée par le serveur.",
          { description: "Voir « Ventes en attente » pour la corriger." },
        );
      } else {
        toast.info(PENDING_MESSAGE, {
          description:
            "Elle sera envoyée automatiquement au retour de la connexion.",
        });
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !submitting && onOpenChange(v)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {replaces ? "Corriger la vente" : "Vente"} — {productName}
          </DialogTitle>
          {!online && (
            <DialogDescription className="flex items-start gap-1.5">
              <WifiOffIcon
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                aria-hidden
              />
              La vente sera enregistrée sur cet appareil et envoyée au retour de
              la connexion.
            </DialogDescription>
          )}
        </DialogHeader>
        {!canRecordSales ? (
          <p role="alert" className="text-sm text-destructive">
            {REFUSAL_MESSAGES.capability}
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="mt-2 space-y-4" noValidate>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="s-qty">Quantité</Label>
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
                    {indicative.hasReservation ? "Stock indicatif" : "Stock"} :{" "}
                    {maxQuantity}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="s-price">Prix de vente réel (FCFA)</Label>
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
                    Total :{" "}
                    {fmtXof(Number(salePrice) * (Number(quantity) || 1))}
                  </p>
                )}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="s-buyer">Nom acheteur (optionnel)</Label>
              <Input
                id="s-buyer"
                maxLength={TEXT_MAX}
                value={buyerName}
                onChange={(e) => setBuyerName(e.target.value)}
                placeholder="Prénom / Nom"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="s-contact">Contact acheteur (optionnel)</Label>
              <Input
                id="s-contact"
                maxLength={TEXT_MAX}
                value={buyerContact}
                onChange={(e) => setBuyerContact(e.target.value)}
                placeholder="Téléphone ou email"
              />
            </div>
            {indicative.hasReservation && (
              <p className="text-xs text-muted-foreground">
                Des ventes de ce produit sont en attente d&apos;envoi : le stock
                affiché est indicatif.
              </p>
            )}
            {formError && (
              <p role="alert" className="text-sm text-destructive">
                {formError}{" "}
                {formError === REFUSAL_MESSAGES.limit && (
                  <PendingSalesAnchor
                    href={pendingLink.href}
                    offline={pendingLink.offline}
                  >
                    Voir les ventes en attente
                  </PendingSalesAnchor>
                )}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting
                ? online
                  ? "Envoi…"
                  : "Enregistrement…"
                : replaces
                  ? "Enregistrer la correction"
                  : "Confirmer la vente"}
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
        Enregistrer une vente
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
