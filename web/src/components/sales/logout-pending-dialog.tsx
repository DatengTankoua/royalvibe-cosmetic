"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExportButtons } from "@/components/sales/pending-sales-panel";
import type { OutboxOperation } from "@/lib/offline-sales-outbox-db";

// 1-11C.3 — Déconnexion volontaire avec des ventes locales non finalisées
// (toutes organisations de l'utilisateur). Aucune option n'est appliquée par
// défaut ; la suppression exige une seconde confirmation explicite.
export function LogoutPendingDialog({
  operations,
  online,
  canSync,
  onCancel,
  onSyncNow,
  onKeepAndLogout,
  onDeleteAndLogout,
}: {
  operations: OutboxOperation[];
  online: boolean;
  canSync: boolean;
  onCancel: () => void;
  onSyncNow: () => Promise<void>;
  onKeepAndLogout: () => Promise<void>;
  onDeleteAndLogout: () => Promise<boolean>;
}) {
  const [step, setStep] = useState<"choose" | "confirm-delete">("choose");
  const [busy, setBusy] = useState<null | "sync" | "keep" | "delete">(null);
  const [error, setError] = useState<string | null>(null);
  const organizations = new Set(operations.map((op) => op.organizationId));

  const run = async (
    kind: "sync" | "keep" | "delete",
    fn: () => Promise<void>,
  ) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ventes non synchronisées</DialogTitle>
          <DialogDescription>
            {operations.length} vente{operations.length > 1 ? "s" : ""}{" "}
            enregistrée{operations.length > 1 ? "s" : ""} sur cet appareil{" "}
            {organizations.size > 1
              ? `(${organizations.size} organisations) `
              : ""}
            n&apos;{operations.length > 1 ? "ont" : "a"} pas encore été
            confirmée{operations.length > 1 ? "s" : ""} par le serveur.
          </DialogDescription>
        </DialogHeader>

        {step === "choose" ? (
          <div className="flex flex-col gap-3">
            {online && canSync && (
              <Button
                type="button"
                disabled={busy !== null}
                onClick={() => void run("sync", onSyncNow)}
              >
                {busy === "sync"
                  ? "Synchronisation… (10 s max)"
                  : "Synchroniser maintenant"}
              </Button>
            )}
            <ExportButtons operations={operations} />
            <Button
              type="button"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void run("keep", onKeepAndLogout)}
            >
              Se déconnecter et conserver sur cet appareil
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="text-destructive"
              disabled={busy !== null}
              onClick={() => setStep("confirm-delete")}
            >
              Supprimer définitivement…
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy !== null}
              onClick={onCancel}
            >
              Annuler
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p role="alert" className="text-sm text-destructive">
              Ces ventes seront effacées de cet appareil et ne seront JAMAIS
              envoyées au serveur. Action irréversible : exporte-les
              d&apos;abord si nécessaire.
            </p>
            <ExportButtons operations={operations} />
            <Button
              type="button"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy !== null}
              onClick={() =>
                void run("delete", async () => {
                  if (!(await onDeleteAndLogout())) {
                    setError(
                      "Suppression impossible : rien n'a été effacé. Réessaie ou conserve les ventes.",
                    );
                  }
                })
              }
            >
              Supprimer définitivement et se déconnecter
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy !== null}
              onClick={() => setStep("choose")}
            >
              Retour
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
