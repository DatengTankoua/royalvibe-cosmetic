"use client";

import { useState } from "react";
import { useT } from "next-i18next/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  const { t } = useT("sales");
  const [error, setError] = useState(false);
  const organizations = new Set(operations.map((op) => op.organizationId));

  const run = async (
    kind: "sync" | "keep" | "delete",
    fn: () => Promise<void>,
  ) => {
    if (busy) return;
    setBusy(kind);
    setError(false);
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
          <DialogTitle>{t("logout.title")}</DialogTitle>
          <DialogDescription>
            {organizations.size > 1
              ? t("logout.descriptionOrganizations", {
                  count: operations.length,
                  organizations: organizations.size,
                })
              : t("logout.description", { count: operations.length })}
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
                {busy === "sync" ? t("logout.syncing") : t("syncNow")}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void run("keep", onKeepAndLogout)}
            >
              {t("logout.keep")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="text-destructive"
              disabled={busy !== null}
              onClick={() => setStep("confirm-delete")}
            >
              {t("logout.delete")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy !== null}
              onClick={onCancel}
            >
              {t("actions.cancel")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p role="alert" className="text-sm text-destructive">
              {t("logout.deleteWarning")}
            </p>
            <Button
              type="button"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy !== null}
              onClick={() =>
                void run("delete", async () => {
                  if (!(await onDeleteAndLogout())) {
                    setError(true);
                  }
                })
              }
            >
              {t("logout.deleteConfirm")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy !== null}
              onClick={() => setStep("choose")}
            >
              {t("actions.back")}
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {t("logout.deleteFailed")}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
