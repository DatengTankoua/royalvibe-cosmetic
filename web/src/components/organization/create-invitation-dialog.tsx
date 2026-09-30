"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { CheckIcon, CopyIcon, PlusIcon } from "lucide-react";
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
  roleGrantsAllPermissions,
  type DelegablePermission,
} from "@/lib/organization-permissions";
import { describeOrganizationError } from "@/lib/organization-errors";
import {
  createInvitation,
  type ApiInvitation,
  type CreatedInvitation,
} from "@/lib/api";

interface CreateInvitationDialogProps {
  onCreated: (invitation: ApiInvitation) => void;
}

type CopyState = "idle" | "copied" | "manual";

function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    dateStyle: "long",
    timeStyle: "short",
  });
}

// 1-12G : aucun email envoyé — le créateur copie le lien et le transmet
// lui-même. Le lien (jeton brut inclus) n'est renvoyé qu'UNE SEULE fois par
// la réponse de création : uniquement en mémoire (état React), jamais
// persisté dans localStorage/sessionStorage, jamais journalisé, jamais
// reconstruit après fermeture/rechargement.
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
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const submitting = useRef(false);
  const linkInput = useRef<HTMLInputElement>(null);

  const reset = () => {
    setEmail("");
    setRole("seller");
    setPermissions([]);
    setError(null);
    setCreated(null);
    setCopyState("idle");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Garde synchrone : un double clic ne crée jamais deux invitations.
    if (submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError(null);
    try {
      // 1-12H : administrateur → toutes les permissions par défaut côté
      // serveur ; la sélection vendeur conservée n'est pas envoyée.
      const result = await createInvitation({
        email,
        role,
        permissions: roleGrantsAllPermissions(role) ? [] : permissions,
      });
      onCreated(result.invitation);
      setCreated(result);
      toast.success("Invitation créée");
    } catch (err) {
      setError(describeOrganizationError(err));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  const selectLink = () => {
    linkInput.current?.focus();
    linkInput.current?.select();
  };

  // Copie seulement : ne rappelle jamais l'API. En cas d'échec du
  // presse-papiers, le lien est sélectionné pour une copie manuelle.
  const handleCopy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.invitationUrl);
      setCopyState("copied");
    } catch {
      setCopyState("manual");
      selectLink();
    }
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
            <DialogTitle>
              {created ? "Invitation créée" : "Nouvelle invitation"}
            </DialogTitle>
          </DialogHeader>

          {created ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Copie ce lien et transmets-le à {created.invitation.email}. Il
                n&apos;est affiché qu&apos;une seule fois.
              </p>
              <div className="space-y-2">
                <Label htmlFor="invite-link">Lien d&apos;invitation</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="invite-link"
                    ref={linkInput}
                    readOnly
                    value={created.invitationUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    aria-describedby="invite-link-status"
                    className="text-xs"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleCopy()}
                  >
                    {copyState === "copied" ? (
                      <CheckIcon className="mr-1 h-3.5 w-3.5" />
                    ) : (
                      <CopyIcon className="mr-1 h-3.5 w-3.5" />
                    )}
                    Copier le lien
                  </Button>
                </div>
                <p
                  id="invite-link-status"
                  role="status"
                  className={
                    copyState === "manual"
                      ? "text-sm text-destructive"
                      : "text-sm text-muted-foreground"
                  }
                >
                  {copyState === "copied" && "Lien copié"}
                  {copyState === "manual" &&
                    "Copie automatique impossible : le lien est sélectionné, copie-le manuellement."}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Expire le {formatExpiry(created.invitation.expiresAt)}.
              </p>
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
                  allGranted={roleGrantsAllPermissions(role)}
                />
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={saving}>
                {saving ? "Création…" : "Créer l'invitation"}
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
