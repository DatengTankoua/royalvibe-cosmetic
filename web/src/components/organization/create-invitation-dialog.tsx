"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  CheckCircle2Icon,
  CopyIcon,
  InfoIcon,
  PlusIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionCheckboxes } from "@/components/organization/permission-checkboxes";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import {
  INVITABLE_ROLES,
  ROLE_LABELS,
  type DelegablePermission,
} from "@/lib/organization-permissions";
import { describeOrganizationError } from "@/lib/organization-errors";
import { createInvitation, type ApiInvitation } from "@/lib/api";

interface CreateInvitationDialogProps {
  onCreated: (invitation: ApiInvitation) => void;
}

// Le jeton brut n'est renvoyé qu'UNE SEULE fois par la réponse de création
// (jamais reconstruit après fermeture/rechargement) — jamais persisté dans
// localStorage/sessionStorage, jamais journalisé.
export function CreateInvitationDialog({
  onCreated,
}: CreateInvitationDialogProps) {
  const { authContext } = useOrganizationShell();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<(typeof INVITABLE_ROLES)[number]>("seller");
  const [permissions, setPermissions] = useState<DelegablePermission[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acceptLink, setAcceptLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [deliveryStatus, setDeliveryStatus] = useState<
    "sent" | "manual" | "failed" | null
  >(null);

  const reset = () => {
    setEmail("");
    setRole("seller");
    setPermissions([]);
    setError(null);
    setAcceptLink(null);
    setCopied(false);
    setDeliveryStatus(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { invitation, token, delivery } = await createInvitation({
        email,
        role,
        permissions,
      });
      onCreated(invitation);
      // Jeton brut : uniquement en mémoire (état React), jamais persisté
      // (localStorage/sessionStorage) ni journalisé.
      setAcceptLink(
        `${window.location.origin}/auth/invitations/accept?token=${token}`,
      );
      setDeliveryStatus(delivery.status);
      if (delivery.status === "sent") {
        toast.success("Invitation créée et email envoyé");
      } else {
        toast.success("Invitation créée");
      }
    } catch (err) {
      setError(describeOrganizationError(err));
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    if (!acceptLink) return;
    await navigator.clipboard.writeText(acceptLink);
    setCopied(true);
  };

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <PlusIcon className="mr-1 h-4 w-4" />
        Inviter un membre
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nouvelle invitation</DialogTitle>
          </DialogHeader>

          {acceptLink ? (
            <div className="space-y-3">
              {deliveryStatus === "sent" && (
                <p className="flex items-start gap-2 text-sm text-muted-foreground">
                  <CheckCircle2Icon className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                  Email envoyé à l&apos;invité(e). Le lien reste disponible
                  ci-dessous si besoin de le partager toi-même.
                </p>
              )}
              {deliveryStatus === "manual" && (
                <p className="flex items-start gap-2 text-sm text-muted-foreground">
                  <InfoIcon className="mt-0.5 h-4 w-4 shrink-0" />
                  L&apos;envoi automatique d&apos;email n&apos;est pas configuré
                  : partage ce lien manuellement avec l&apos;invité(e).
                </p>
              )}
              {deliveryStatus === "failed" && (
                <p className="flex items-start gap-2 text-sm text-destructive">
                  <TriangleAlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
                  L&apos;email n&apos;a pas pu être envoyé. L&apos;invitation
                  reste valable : partage ce lien manuellement.
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                Lien d&apos;invitation — affiché une seule fois, transmets-le
                dès maintenant.
              </p>
              <div className="flex items-center gap-2">
                <Input readOnly value={acceptLink} className="text-xs" />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleCopy()}
                >
                  <CopyIcon className="mr-1 h-3.5 w-3.5" />
                  {copied ? "Copié" : "Copier"}
                </Button>
              </div>
              <Button
                type="button"
                className="w-full"
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
              >
                Fermer
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4 mt-2">
              <div className="space-y-2">
                <Label htmlFor="invite-email">Email</Label>
                <Input
                  id="invite-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="invite-role">Rôle</Label>
                <select
                  id="invite-role"
                  value={role}
                  onChange={(e) =>
                    setRole(e.target.value as (typeof INVITABLE_ROLES)[number])
                  }
                  className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                >
                  {INVITABLE_ROLES.map((r) => (
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
                  assignable={authContext?.effectivePermissions ?? []}
                  disabled={saving}
                />
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={saving}>
                {saving ? "Envoi…" : "Créer l'invitation"}
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
