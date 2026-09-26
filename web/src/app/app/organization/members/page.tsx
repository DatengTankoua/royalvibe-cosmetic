"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PencilIcon, Crown } from "lucide-react";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
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
import { EditMemberDialog } from "@/components/organization/edit-member-dialog";
import { ROLE_LABELS, PERMISSION_LABELS } from "@/lib/organization-permissions";
import { describeOrganizationError } from "@/lib/organization-errors";
import { fetchMembers, transferOwnership, type ApiMember } from "@/lib/api";

// /app/organization/members (1-9C) — vue minimale renvoyée par
// `GET /organizations/members` uniquement (jamais de champ inventé).
// Édition (role/permissions/status) : `members.manage`. Transfert de
// propriété : `ownership.transfer`, réservé au rôle `owner` STRICT.
export default function OrganizationMembersPage() {
  const { authContext } = useOrganizationShell();
  const [members, setMembers] = useState<ApiMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ApiMember | null>(null);
  const [transferring, setTransferring] = useState<ApiMember | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);

  const canManage =
    authContext?.effectivePermissions.includes("members.manage");
  const isOwner = authContext?.role === "owner";

  // Aucune requête tant que la permission n'est pas confirmée (accès direct
  // par URL sans passer par l'onglet, déjà filtré par permission) : évite un
  // 403 inutile, le backend reste de toute façon l'autorité finale.
  useEffect(() => {
    if (!authContext) return;
    if (!canManage) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchMembers()
      .then((data) => {
        if (!cancelled) setMembers(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeOrganizationError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authContext, canManage]);

  const handleTransfer = async () => {
    if (!transferring) return;
    setTransferBusy(true);
    try {
      const { newOwner, previousOwner } = await transferOwnership(
        transferring.membershipId,
      );
      setMembers((prev) =>
        prev.map((m) => {
          if (m.membershipId === newOwner.membershipId) return newOwner;
          if (m.membershipId === previousOwner.membershipId)
            return previousOwner;
          return m;
        }),
      );
      toast.success("Propriété transférée");
      setTransferring(null);
    } catch (err) {
      toast.error(describeOrganizationError(err));
    } finally {
      setTransferBusy(false);
    }
  };

  if (loading || !authContext) {
    return <p className="text-sm text-muted-foreground">Chargement…</p>;
  }
  if (!canManage) {
    return (
      <p className="text-sm text-muted-foreground">
        La permission « Gérer les membres » est requise pour accéder à cet
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
    <div className="space-y-3">
      {members.map((member) => {
        const isSelf = member.user._id === authContext?.userId;
        const isTargetOwner = member.role === "owner";
        const canEditThis = canManage && !isSelf && !isTargetOwner;
        const canTransferToThis =
          isOwner && !isSelf && !isTargetOwner && member.status === "active";

        return (
          <Card key={member.membershipId}>
            <CardContent className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {member.user.name}
                  {isTargetOwner && (
                    <Crown className="ml-1 inline h-3.5 w-3.5 text-amber-500" />
                  )}
                  {isSelf && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      (vous)
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {member.user.email}
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Badge variant="secondary">{ROLE_LABELS[member.role]}</Badge>
                  <Badge
                    variant={
                      member.status === "active" ? "default" : "destructive"
                    }
                  >
                    {member.status === "active"
                      ? "Active"
                      : member.status === "suspended"
                        ? "Suspendue"
                        : "Révoquée"}
                  </Badge>
                  {member.permissions.map((p) => (
                    <Badge key={p} variant="outline" className="text-xs">
                      {PERMISSION_LABELS[p]}
                    </Badge>
                  ))}
                </div>
              </div>

              {(canEditThis || canTransferToThis) && (
                <div className="flex shrink-0 gap-2">
                  {canEditThis && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditing(member)}
                    >
                      <PencilIcon className="mr-1 h-3.5 w-3.5" />
                      Modifier
                    </Button>
                  )}
                  {canTransferToThis && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setTransferring(member)}
                    >
                      Transférer la propriété
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      {editing && (
        <EditMemberDialog
          member={editing}
          assignablePermissions={authContext?.effectivePermissions ?? []}
          onClose={() => setEditing(null)}
          onUpdated={(updated) =>
            setMembers((prev) =>
              prev.map((m) =>
                m.membershipId === updated.membershipId ? updated : m,
              ),
            )
          }
        />
      )}

      <AlertDialog
        open={!!transferring}
        onOpenChange={(open) => !open && setTransferring(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Transférer la propriété ?</AlertDialogTitle>
            <AlertDialogDescription>
              Tu vas céder définitivement la propriété de cette organisation à{" "}
              <strong>{transferring?.user.name}</strong>. Tu deviendras
              administrateur et ne pourras plus annuler cette action toi-même.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={transferBusy}
              onClick={() => void handleTransfer()}
            >
              {transferBusy ? "Transfert…" : "Confirmer le transfert"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
