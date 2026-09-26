"use client";

import { useState } from "react";
import { toast } from "sonner";
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
  ROLE_LABELS,
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
const STATUS_LABELS: Record<(typeof STATUS_OPTIONS)[number], string> = {
  active: "Active",
  suspended: "Suspendue",
  revoked: "Révoquée",
};

export function EditMemberDialog({
  member,
  assignablePermissions,
  onClose,
  onUpdated,
}: EditMemberDialogProps) {
  const [role, setRole] = useState<(typeof ASSIGNABLE_MEMBER_ROLES)[number]>(
    member.role === "owner" ? "admin" : member.role,
  );
  const [permissions, setPermissions] = useState<DelegablePermission[]>(
    member.permissions,
  );
  const [status, setStatus] = useState<(typeof STATUS_OPTIONS)[number]>(
    member.status,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const updated = await updateMember(member.membershipId, {
        role,
        permissions,
        status,
      });
      onUpdated(updated);
      toast.success("Membre mis à jour");
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
          <DialogTitle>Modifier {member.user.name}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-2">
            <Label htmlFor="member-role">Rôle</Label>
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
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label>Permissions supplémentaires</Label>
            <PermissionCheckboxes
              value={permissions}
              onChange={setPermissions}
              assignable={assignablePermissions}
              disabled={saving}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="member-status">Statut</Label>
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
                  {STATUS_LABELS[s]}
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
            {saving ? "Enregistrement…" : "Enregistrer"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
