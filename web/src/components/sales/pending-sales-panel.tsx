"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangleIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { SaleFormDialog } from "@/components/products/record-sale-dialog";
import {
  OFFLINE_SALES_PANEL_ID,
  OFFLINE_SALES_PANEL_OPEN_EVENT,
  useOfflineSales,
} from "@/contexts/offline-sales-context";
import { fmtXof } from "@/lib/currency";
import {
  allowedOperationActions,
  describeOperationError,
  isUnfinalized,
} from "@/lib/offline-sales-policy";
import type { OutboxOperation } from "@/lib/offline-sales-outbox-db";

const STATUS_LABEL: Record<OutboxOperation["status"], string> = {
  pending: "En attente",
  syncing: "Envoi en cours",
  synced: "Synchronisée",
  conflict: "À traiter",
  abandoned: "Abandonnée",
};

const STATUS_VARIANT = {
  pending: "secondary",
  syncing: "secondary",
  synced: "default",
  conflict: "destructive",
  abandoned: "outline",
} as const;

// 1-11C.3 — Ventes locales de la partition COURANTE : compteurs, statut,
// dernière erreur (message générique) et actions de résolution.
// 1-16D : l'export local JSON/CSV est retiré ; l'historique des ventes
// synchronisées se télécharge depuis Analyses.
// Aucune erreur brute, aucun token ni empreinte affichés.
export function PendingSalesPanel() {
  const { status, operations, blocked, online, syncNow, act } =
    useOfflineSales();
  const [editing, setEditing] = useState<OutboxOperation | null>(null);
  const [confirm, setConfirm] = useState<{
    op: OutboxOperation;
    action: "abandon" | "remove-corrupted";
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const counts = {
    pending: operations.filter((op) => op.status === "pending").length,
    syncing: operations.filter((op) => op.status === "syncing").length,
    conflict: operations.filter((op) => op.status === "conflict").length,
  };
  const unfinalized = operations.filter((op) => isUnfinalized(op.status));
  const synced = operations.filter((op) => op.status === "synced");

  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  if (status === "idle" || status === "loading") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Chargement des ventes locales…
      </p>
    );
  }
  if (status === "error" || status === "unavailable") {
    return (
      <p role="alert" className="text-sm text-destructive">
        Ventes locales illisibles pour cette session. Reconnecte-toi pour y
        accéder ; elles restent conservées sur cet appareil.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-3 gap-2 text-center">
        {(
          [
            ["En attente", counts.pending],
            ["Envoi", counts.syncing],
            ["À traiter", counts.conflict],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="rounded-md border p-2">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-lg font-semibold">{value}</dd>
          </div>
        ))}
      </dl>

      {blocked && (
        <div
          role="alert"
          className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
        >
          <ShieldAlertIcon
            className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
            aria-hidden
          />
          <p>
            {blocked.reason === "subscription"
              ? "Envoi suspendu : l'abonnement de ce commerce n'est pas actif. Les ventes restent sur cet appareil et repartiront après le renouvellement."
              : blocked.reason === "access_denied"
                ? "Envoi suspendu : le serveur a refusé l'accès (session, droits ou organisation). Reconnecte-toi ou contacte un administrateur ; les ventes restent sur cet appareil."
                : "Envoi suspendu : une incohérence a été détectée. Note les ventes concernées et contacte le support avant de retirer l'opération."}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        {counts.pending > 0 && !blocked && (
          <Button
            type="button"
            size="sm"
            disabled={!online || busy}
            onClick={() => void run(syncNow)}
          >
            <RefreshCwIcon className="mr-1 h-3.5 w-3.5" aria-hidden />
            Synchroniser maintenant
          </Button>
        )}
      </div>
      {!online && counts.pending > 0 && (
        <p className="text-xs text-muted-foreground">
          L&apos;envoi reprendra automatiquement au retour de la connexion,
          application ouverte.
        </p>
      )}

      {unfinalized.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Aucune vente en attente sur cet appareil.
        </p>
      ) : (
        <ul className="space-y-2" aria-label="Ventes non finalisées">
          {unfinalized.map((op) => (
            <OperationItem
              key={op.clientOperationId}
              op={op}
              busy={busy}
              onEdit={() => setEditing(op)}
              onRetry={() =>
                void run(async () => {
                  if (!(await act(op.clientOperationId, "retry"))) {
                    toast.error("Action impossible.");
                  }
                })
              }
              onAbandon={() => setConfirm({ op, action: "abandon" })}
              onRemoveCorrupted={() =>
                setConfirm({ op, action: "remove-corrupted" })
              }
            />
          ))}
        </ul>
      )}

      {synced.length > 0 && (
        <details className="rounded-md border p-3 text-sm">
          <summary className="cursor-pointer font-medium">
            Récemment synchronisées ({synced.length})
          </summary>
          <p className="mt-1 text-xs text-muted-foreground">
            Effacées automatiquement de cet appareil après 7 jours.
          </p>
          <ul className="mt-2 space-y-1">
            {synced.map((op) => (
              <li
                key={op.clientOperationId}
                className="flex justify-between gap-2 text-xs"
              >
                <span className="min-w-0 truncate">
                  {op.display.productName} — {op.payload.quantity} ×{" "}
                  {fmtXof(op.payload.salePrice)}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {op.lastError?.code === "SALE_OPERATION_ALREADY_APPLIED"
                    ? "Annulée ensuite"
                    : "Confirmée"}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {editing && (
        <SaleFormDialog
          key={editing.clientOperationId}
          open
          onOpenChange={(v) => !v && setEditing(null)}
          productId={editing.payload.productId}
          productName={editing.display.productName}
          targetPrice={editing.display.unitPriceHint}
          initial={{
            quantity: editing.payload.quantity,
            salePrice: editing.payload.salePrice,
            buyerName: editing.payload.buyerName,
            buyerContact: editing.payload.buyerContact,
          }}
          replaces={editing.clientOperationId}
        />
      )}

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(v) => !v && setConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.action === "remove-corrupted"
                ? "Retirer cette vente de la file ?"
                : "Abandonner cette vente ?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm && allowedOperationActions(confirm.op).mayBeRecorded
                ? "Attention : le serveur a peut-être déjà enregistré cette vente. Vérifie la liste des ventes avant de l'abandonner. "
                : "Cette vente ne sera jamais envoyée au serveur. "}
              Elle ne sera plus proposée à l&apos;envoi et restera visible sur
              cet appareil (aucune suppression silencieuse).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const target = confirm;
                setConfirm(null);
                if (!target) return;
                void run(async () => {
                  if (
                    !(await act(target.op.clientOperationId, target.action))
                  ) {
                    toast.error("Action impossible.");
                  }
                });
              }}
            >
              {confirm?.action === "remove-corrupted"
                ? "Retirer"
                : "Abandonner"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function OperationItem({
  op,
  busy,
  onEdit,
  onRetry,
  onAbandon,
  onRemoveCorrupted,
}: {
  op: OutboxOperation;
  busy: boolean;
  onEdit: () => void;
  onRetry: () => void;
  onAbandon: () => void;
  onRemoveCorrupted: () => void;
}) {
  const allowed = allowedOperationActions(op);
  const message = describeOperationError(op.lastError);
  return (
    <li>
      <Card>
        <CardContent className="space-y-2 py-3 text-sm">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate font-semibold">{op.display.productName}</p>
              <p className="text-xs text-muted-foreground">
                {new Date(op.payload.occurredAt).toLocaleString("fr-FR")}
              </p>
            </div>
            <Badge variant={STATUS_VARIANT[op.status]} className="shrink-0">
              {STATUS_LABEL[op.status]}
            </Badge>
          </div>
          <p>
            {op.payload.quantity} × {fmtXof(op.payload.salePrice)} ={" "}
            <strong>
              {fmtXof(op.payload.quantity * op.payload.salePrice)}
            </strong>
          </p>
          {(op.payload.buyerName || op.payload.buyerContact) && (
            <p className="wrap-break-word text-xs text-muted-foreground">
              Acheteur : {op.payload.buyerName ?? "—"}
              {op.payload.buyerContact ? ` — ${op.payload.buyerContact}` : ""}
            </p>
          )}
          {(message || op.attempts > 0) && (
            <p className="flex items-start gap-1 text-xs text-muted-foreground">
              {op.status === "conflict" && (
                <AlertTriangleIcon
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive"
                  aria-hidden
                />
              )}
              <span>
                {message}
                {op.attempts > 0 ? ` Tentatives : ${op.attempts}.` : ""}
              </span>
            </p>
          )}
          {(allowed.edit ||
            allowed.retry ||
            allowed.abandon ||
            allowed.removeCorrupted) && (
            <div className="flex flex-wrap gap-2 pt-1">
              {allowed.edit && (
                <Button
                  type="button"
                  size="sm"
                  onClick={onEdit}
                  disabled={busy}
                >
                  Corriger
                </Button>
              )}
              {allowed.retry && (
                <Button
                  type="button"
                  size="sm"
                  onClick={onRetry}
                  disabled={busy}
                >
                  Réessayer
                </Button>
              )}
              {allowed.abandon && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={onAbandon}
                  disabled={busy}
                >
                  Abandonner
                </Button>
              )}
              {allowed.removeCorrupted && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={onRemoveCorrupted}
                  disabled={busy}
                >
                  Retirer de la file
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </li>
  );
}

// Shell sans organisation active (accès révoqué) : les ventes locales
// restent consultables avant déconnexion. Rien si la file
// est vide.
export function PendingSalesIfAny() {
  const { unfinalizedCount } = useOfflineSales();
  if (unfinalizedCount === 0) return null;
  return (
    <section
      aria-label="Ventes en attente sur cet appareil"
      className="w-full space-y-3 text-left"
    >
      <h2 className="text-base font-semibold">
        Ventes en attente sur cet appareil
      </h2>
      <PendingSalesPanel />
    </section>
  );
}

/**
 * Panneau intégré à `/app/catalog` hors ligne (seule route /app servie par le
 * service worker). Ancre `#offline-sales-panel` : ouvert, rendu visible et
 * focalisé au chargement avec ce fragment, sur `hashchange` ou sur
 * l'événement émis par le lien « ventes en attente ».
 */
export function OfflineSalesPanelSection({ count }: { count: number }) {
  const [open, setOpen] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const reveal = () => {
      if (window.location.hash !== `#${OFFLINE_SALES_PANEL_ID}`) return;
      setOpen(true);
      requestAnimationFrame(() => {
        sectionRef.current?.scrollIntoView({ block: "start" });
        sectionRef.current?.focus({ preventScroll: true });
      });
    };
    const onRequest = () => {
      // Le fragment peut être déjà présent : ouverture explicite.
      setTimeout(reveal, 0);
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    window.addEventListener(OFFLINE_SALES_PANEL_OPEN_EVENT, onRequest);
    return () => {
      window.removeEventListener("hashchange", reveal);
      window.removeEventListener(OFFLINE_SALES_PANEL_OPEN_EVENT, onRequest);
    };
  }, []);

  return (
    <section
      id={OFFLINE_SALES_PANEL_ID}
      ref={sectionRef}
      tabIndex={-1}
      aria-label="Ventes en attente sur cet appareil"
      className="scroll-mt-24 rounded-md border p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <details
        open={open}
        onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer text-sm font-medium">
          Ventes en attente sur cet appareil ({count})
        </summary>
        <div className="mt-3">
          <PendingSalesPanel />
        </div>
      </details>
    </section>
  );
}
