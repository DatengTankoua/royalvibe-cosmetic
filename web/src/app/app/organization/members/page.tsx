"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useT } from "next-i18next/client";
import { messageText, useMessage } from "@/i18n/use-message";
import { rich } from "@/i18n/rich";
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
import { describeOrganizationError } from "@/lib/organization-errors";
import { fetchMembers, transferOwnership, type ApiMember } from "@/lib/api";
import { useLiveRefresh, useSocketSignals } from "@/hooks/use-live-refresh";
import { createResponseOrder } from "@/lib/refresh-coordinator";

// 1-15C : droits, rôle, statut, transfert ou nouveau membre (payload vide).
const MEMBER_SIGNALS = ["members:changed"] as const;

// /app/organization/members (1-9C) — vue minimale renvoyée par
// `GET /organizations/members` uniquement (jamais de champ inventé).
// Édition (role/permissions/status) : `members.manage`. Transfert de
// propriété : `ownership.transfer`, réservé au rôle `owner` STRICT.
export default function OrganizationMembersPage() {
  const { t } = useT("organization");
  const { authContext } = useOrganizationShell();
  const [members, setMembers] = useState<ApiMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useMessage("organization");
  const [editing, setEditing] = useState<ApiMember | null>(null);
  const [transferring, setTransferring] = useState<ApiMember | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);

  const canManage =
    authContext?.effectivePermissions.includes("members.manage");
  const isOwner = authContext?.role === "owner";

  // 1-15C : ordre des réponses et début de la dernière lecture appliquée
  // (rattrapage après reconnexion). Les pages sont remontées à tout
  // changement de session ou de droits (1-15A) : une réponse d'un ancien
  // contexte n'est jamais appliquée.
  const order = useRef(createResponseOrder());
  const [loadedAt, setLoadedAt] = useState<number | undefined>(undefined);
  const load = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!options.silent) setLoading(true);
      const requestedAt = Date.now();
      const ticket = order.current.begin();
      try {
        const data = await fetchMembers();
        if (!order.current.accept(ticket)) return;
        setMembers(data);
        setError(null);
        setLoadedAt(requestedAt);
      } catch (err: unknown) {
        // Une relecture silencieuse en échec conserve la liste affichée.
        if (!options.silent) setError(describeOrganizationError(err));
      } finally {
        if (!options.silent) setLoading(false);
      }
    },
    [setError],
  );

  // Aucune requête tant que la permission n'est pas confirmée (accès direct
  // par URL sans passer par l'onglet, déjà filtré par permission) : évite un
  // 403 inutile, le backend reste de toute façon l'autorité finale.
  useEffect(() => {
    if (!authContext) return;
    if (!canManage) {
      setLoading(false);
      return;
    }
    void load();
  }, [authContext, canManage, load]);

  // 1-15C : relecture silencieuse sur signal, SEULEMENT avec
  // `members.manage` (jamais de requête protégée sans le droit).
  const scheduleRefresh = useLiveRefresh(
    () => (canManage ? load({ silent: true }) : Promise.resolve()),
    canManage ? loadedAt : undefined,
  );
  useSocketSignals(MEMBER_SIGNALS, canManage ? scheduleRefresh : () => {});

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
      toast.success(t("members.transferred"));
      setTransferring(null);
    } catch (err) {
      toast.error(messageText(describeOrganizationError(err), t));
    } finally {
      setTransferBusy(false);
    }
  };

  if (loading || !authContext) {
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>;
  }
  if (!canManage) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("members.permissionRequired", {
          permission: t("permissions.members.manage"),
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
                    <Crown className="ml-1 inline h-3.5 w-3.5 text-amber-500 dark:text-amber-400" />
                  )}
                  {isSelf && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      {t("members.you")}
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {member.user.email}
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Badge variant="secondary">{t(`roles.${member.role}`)}</Badge>
                  <Badge
                    variant={
                      member.status === "active" ? "default" : "destructive"
                    }
                  >
                    {t(`memberStatus.${member.status}`)}
                  </Badge>
                  {member.permissions.map((p) => (
                    <Badge key={p} variant="outline" className="text-xs">
                      {t(`permissions.${p}`)}
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
                      {t("members.edit")}
                    </Button>
                  )}
                  {canTransferToThis && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setTransferring(member)}
                    >
                      {t("members.transfer")}
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
            <AlertDialogTitle>{t("members.transferTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {rich(t("members.transferText"), {
                name: () => <strong>{transferring?.user.name}</strong>,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={transferBusy}
              onClick={() => void handleTransfer()}
            >
              {transferBusy
                ? t("members.transferring")
                : t("members.transferConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
