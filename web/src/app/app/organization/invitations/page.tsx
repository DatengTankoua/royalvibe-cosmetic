"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import { messageText, useMessage } from "@/i18n/use-message";
import { rich } from "@/i18n/rich";
import { Ban } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { CreateInvitationDialog } from "@/components/organization/create-invitation-dialog";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import { describeOrganizationError } from "@/lib/organization-errors";
import {
  fetchInvitations,
  revokeInvitation,
  type ApiInvitation,
} from "@/lib/api";
import { useLiveRefresh, useSocketSignals } from "@/hooks/use-live-refresh";
import { createResponseOrder } from "@/lib/refresh-coordinator";

// 1-15C : création, révocation ou acceptation (payload vide).
const INVITATION_SIGNALS = ["invitations:changed"] as const;

const STATUS_VARIANT: Record<
  ApiInvitation["status"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "default",
  accepted: "secondary",
  revoked: "destructive",
  expired: "outline",
};

// /app/organization/invitations (1-9C) — `members.invite`. Le jeton brut
// n'existe que dans la réponse de création (voir CreateInvitationDialog) :
// cette liste ne l'affiche/reconstruit JAMAIS.
export default function OrganizationInvitationsPage() {
  const { t } = useT("organization");
  const format = useFormat();
  const { authContext } = useOrganizationShell();
  const [invitations, setInvitations] = useState<ApiInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useMessage("organization");
  const [revoking, setRevoking] = useState<ApiInvitation | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  const canInvite =
    authContext?.effectivePermissions.includes("members.invite");

  // 1-15C : ordre des réponses, début de la dernière lecture appliquée
  // (rattrapage après reconnexion).
  const order = useRef(createResponseOrder());
  const [loadedAt, setLoadedAt] = useState<number | undefined>(undefined);
  const load = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!options.silent) setLoading(true);
      const requestedAt = Date.now();
      const ticket = order.current.begin();
      try {
        const data = await fetchInvitations();
        if (!order.current.accept(ticket)) return;
        setInvitations(data);
        setError(null);
        setLoadedAt(requestedAt);
      } catch (err: unknown) {
        if (!options.silent) setError(describeOrganizationError(err));
      } finally {
        if (!options.silent) setLoading(false);
      }
    },
    [setError],
  );

  // Aucune requête tant que la permission n'est pas confirmée (accès direct
  // par URL, l'onglet étant déjà filtré) : le backend reste de toute façon
  // l'autorité finale.
  useEffect(() => {
    if (!authContext) return;
    if (!canInvite) {
      setLoading(false);
      return;
    }
    void load();
  }, [authContext, canInvite, load]);

  // 1-15C : relecture silencieuse sur signal, SEULEMENT avec
  // `members.invite` (jamais de requête protégée sans le droit).
  const scheduleRefresh = useLiveRefresh(
    () => (canInvite ? load({ silent: true }) : Promise.resolve()),
    canInvite ? loadedAt : undefined,
  );
  useSocketSignals(INVITATION_SIGNALS, canInvite ? scheduleRefresh : () => {});

  const handleRevoke = async () => {
    if (!revoking) return;
    setRevokeBusy(true);
    try {
      const updated = await revokeInvitation(revoking._id);
      setInvitations((prev) =>
        prev.map((i) => (i._id === updated._id ? updated : i)),
      );
      toast.success(t("invitations.revoked"));
      setRevoking(null);
    } catch (err) {
      toast.error(messageText(describeOrganizationError(err), t));
    } finally {
      setRevokeBusy(false);
    }
  };

  if (loading || !authContext) {
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>;
  }
  if (!canInvite) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("members.permissionRequired", {
          permission: t("permissions.members.invite"),
        })}
      </p>
    );
  }
  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <CreateInvitationDialog
        onCreated={(invitation) =>
          setInvitations((prev) => [invitation, ...prev])
        }
      />

      {invitations.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("invitations.empty")}
        </p>
      ) : (
        <div className="space-y-3">
          {invitations.map((invitation) => (
            <Card key={invitation._id}>
              <CardContent className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate font-medium">{invitation.email}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Badge variant="secondary">
                      {t(`roles.${invitation.role}`)}
                    </Badge>
                    <Badge variant={STATUS_VARIANT[invitation.status]}>
                      {t(`invitationStatus.${invitation.status}`)}
                    </Badge>
                    {invitation.permissions.map((p) => (
                      <Badge key={p} variant="outline" className="text-xs">
                        {t(`permissions.${p}`)}
                      </Badge>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("invitations.expiresOn", {
                      date: format.date(invitation.expiresAt),
                    })}
                  </p>
                </div>
                {invitation.status === "pending" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0 text-destructive hover:text-destructive"
                    onClick={() => setRevoking(invitation)}
                  >
                    <Ban className="mr-1 h-3.5 w-3.5" />
                    {t("invitations.revoke")}
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog
        open={!!revoking}
        onOpenChange={(open) => !open && setRevoking(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("invitations.revokeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {rich(t("invitations.revokeText"), {
                email: () => <strong>{revoking?.email}</strong>,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={revokeBusy}
              onClick={() => void handleRevoke()}
            >
              {revokeBusy ? t("invitations.revoking") : t("invitations.revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
