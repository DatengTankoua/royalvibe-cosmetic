"use client";

import { useEffect, useState } from "react";
import { fmtXof } from "@/lib/currency";
import {
  onOutboxChanged,
  readPartitionState,
  type OutboxOperation,
} from "@/lib/offline-sales-outbox-db";
import { isUnfinalized } from "@/lib/offline-sales-policy";
import { ExportButtons } from "@/components/sales/pending-sales-panel";

// 1-14C.2 — Ventes locales NON finalisées de l'identité courante, en
// CONSULTATION et EXPORT seuls (accès commercial bloqué ou session limitée).
// Identité = contexte SERVEUR (`GET /auth/context`) ; la lecture exige en
// plus le pointeur d'identité vérifié pour le jeton fourni (aucun
// identifiant libre, aucune autre partition lue). Aucun envoi, aucune action,
// aucune suppression.
export function LocalPendingSales({
  identity,
  token,
}: {
  identity: { userId: string; organizationId: string } | null;
  token: string | null;
}) {
  const [operations, setOperations] = useState<OutboxOperation[] | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const userId = identity?.userId;
  const organizationId = identity?.organizationId;

  useEffect(() => {
    if (!userId || !organizationId || !token) return;
    let cancelled = false;
    const load = () => {
      void readPartitionState({ userId, organizationId, token }).then(
        (state) => {
          if (cancelled) return;
          if (!state) {
            setUnreadable(true);
            return;
          }
          setUnreadable(false);
          setOperations(
            state.operations.filter((op) => isUnfinalized(op.status)),
          );
        },
      );
    };
    load();
    const unsubscribe = onOutboxChanged(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [userId, organizationId, token]);

  if (unreadable) {
    return (
      <p className="text-sm text-muted-foreground">
        Ventes locales illisibles pour cette session : elles restent conservées
        sur cet appareil.
      </p>
    );
  }
  if (!operations || operations.length === 0) return null;

  return (
    <section
      aria-labelledby="local-pending-sales-title"
      className="space-y-3 rounded-xl border p-4"
      data-testid="local-pending-sales"
    >
      <h2 id="local-pending-sales-title" className="text-sm font-semibold">
        Ventes en attente sur cet appareil ({operations.length})
      </h2>
      <p className="text-sm text-muted-foreground">
        Elles sont conservées et seront envoyées après le renouvellement.
      </p>
      <ul className="space-y-1 text-sm">
        {operations.map((op) => (
          <li key={op.clientOperationId} className="flex justify-between gap-2">
            <span className="min-w-0 truncate">
              {op.display.productName} — {op.payload.quantity} ×{" "}
              {fmtXof(op.payload.salePrice)}
            </span>
            <span className="shrink-0 text-muted-foreground">
              {new Date(op.createdAt).toLocaleDateString("fr-FR")}
            </span>
          </li>
        ))}
      </ul>
      <ExportButtons operations={operations} />
    </section>
  );
}
