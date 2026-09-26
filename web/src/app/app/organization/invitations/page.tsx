"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import { ROLE_LABELS, PERMISSION_LABELS } from "@/lib/organization-permissions";
import { describeOrganizationError } from "@/lib/organization-errors";
import {
  fetchInvitations,
  revokeInvitation,
  type ApiInvitation,
} from "@/lib/api";

const STATUS_LABELS: Record<ApiInvitation["status"], string> = {
  pending: "En attente",
  accepted: "Acceptée",
  revoked: "Révoquée",
  expired: "Expirée",
};

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
  const { authContext } = useOrganizationShell();
  const [invitations, setInvitations] = useState<ApiInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiInvitation | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  const canInvite =
    authContext?.effectivePermissions.includes("members.invite");

  // Aucune requête tant que la permission n'est pas confirmée (accès direct
  // par URL, l'onglet étant déjà filtré) : le backend reste de toute façon
  // l'autorité finale.
  useEffect(() => {
    if (!authContext) return;
    if (!canInvite) {
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchInvitations()
      .then(setInvitations)
      .catch((err: unknown) => setError(describeOrganizationError(err)))
      .finally(() => setLoading(false));
  }, [authContext, canInvite]);

  const handleRevoke = async () => {
    if (!revoking) return;
    setRevokeBusy(true);
    try {
      const updated = await revokeInvitation(revoking._id);
      setInvitations((prev) =>
        prev.map((i) => (i._id === updated._id ? updated : i)),
      );
      toast.success("Invitation révoquée");
      setRevoking(null);
    } catch (err) {
      toast.error(describeOrganizationError(err));
    } finally {
      setRevokeBusy(false);
    }
  };

  if (loading || !authContext) {
    return <p className="text-sm text-muted-foreground">Chargement…</p>;
  }
  if (!canInvite) {
    return (
      <p className="text-sm text-muted-foreground">
        La permission « Inviter des membres » est requise pour accéder à cet
        écran.
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
          Aucune invitation pour le moment.
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
                      {ROLE_LABELS[invitation.role]}
                    </Badge>
                    <Badge variant={STATUS_VARIANT[invitation.status]}>
                      {STATUS_LABELS[invitation.status]}
                    </Badge>
                    {invitation.permissions.map((p) => (
                      <Badge key={p} variant="outline" className="text-xs">
                        {PERMISSION_LABELS[p]}
                      </Badge>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Expire le{" "}
                    {new Date(invitation.expiresAt).toLocaleDateString("fr-FR")}
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
                    Révoquer
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
            <AlertDialogTitle>Révoquer cette invitation ?</AlertDialogTitle>
            <AlertDialogDescription>
              L&apos;invitation envoyée à <strong>{revoking?.email}</strong> ne
              pourra plus être acceptée.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={revokeBusy}
              onClick={() => void handleRevoke()}
            >
              {revokeBusy ? "Révocation…" : "Révoquer"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
