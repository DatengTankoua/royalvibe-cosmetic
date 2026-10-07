"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useT } from "next-i18next/client";
import { useMessage } from "@/i18n/use-message";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PermissionCheckboxes } from "@/components/organization/permission-checkboxes";
import {
  ASSIGNABLE_MEMBER_ROLES,
  roleGrantsAllPermissions,
  supplementaryOnly,
  type DelegablePermission,
} from "@/lib/organization-permissions";
import { describeOrganizationError } from "@/lib/organization-errors";
import { updateMember, type ApiMember } from "@/lib/api";

interface EditMemberDialogProps {
  member: ApiMember;
  // Bornes anti-escalade : jamais plus que les permissions effectives de
  // l'acteur (le backend refuse de toute façon tout dépassement).
  assignablePermissions: readonly DelegablePermission[];
  onClose: () => void;
  onUpdated: (member: ApiMember) => void;
}

const STATUS_OPTIONS = ["active", "suspended", "revoked"] as const;

export function EditMemberDialog({
  member,
  assignablePermissions,
  onClose,
  onUpdated,
}: EditMemberDialogProps) {
  const { t } = useT("organization");
  const [role, setRole] = useState<(typeof ASSIGNABLE_MEMBER_ROLES)[number]>(
    member.role === "owner" ? "admin" : member.role,
  );
  // Sélection « vendeur » initialisée UNE fois (droits standard retirés :
  // toujours accordés par le serveur) et conservée si l'on bascule vers
  // Administrateur puis revient — jamais réinitialisée par un rendu.
  const [permissions, setPermissions] = useState<DelegablePermission[]>(() =>
    supplementaryOnly(member.permissions),
  );
  const allGranted = roleGrantsAllPermissions(role);
  const [status, setStatus] = useState<(typeof STATUS_OPTIONS)[number]>(
    member.status,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useMessage("organization");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const updated = await updateMember(member.membershipId, {
        role,
        // 1-12H : administrateur → droits complets par le rôle.
        permissions: allGranted ? [] : permissions,
        status,
      });
      onUpdated(updated);
      toast.success(t("members.updated"));
      onClose();
    } catch (err) {
      setError(describeOrganizationError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("members.editTitle", { name: member.user.name })}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-2">
            <Label htmlFor="member-role">{t("invitations.role")}</Label>
            <select
              id="member-role"
              value={role}
              onChange={(e) =>
                setRole(
                  e.target.value as (typeof ASSIGNABLE_MEMBER_ROLES)[number],
                )
              }
              className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            >
              {ASSIGNABLE_MEMBER_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`roles.${r}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label>{t("permissionsField.label")}</Label>
            <PermissionCheckboxes
              value={permissions}
              onChange={setPermissions}
              assignable={assignablePermissions}
              disabled={saving}
              allGranted={allGranted}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="member-status">{t("members.status")}</Label>
            <select
              id="member-status"
              value={status}
              onChange={(e) =>
                setStatus(e.target.value as (typeof STATUS_OPTIONS)[number])
              }
              className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {t(`memberStatus.${s}`)}
                </option>
              ))}
            </select>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={saving}>
            {saving ? t("saving") : t("actions.save")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
