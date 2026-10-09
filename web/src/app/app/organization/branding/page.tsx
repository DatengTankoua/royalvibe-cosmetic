"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { toast } from "sonner";
import { useT } from "next-i18next/client";
import { useMessage } from "@/i18n/use-message";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getApiErrorMessage,
  removeOrganizationLogo,
  updateOrganizationBranding,
} from "@/lib/api";
import { ORGANIZATION_NAME_MAX_LENGTH } from "@/lib/name-limits";
import { LOGO_ACCEPT, LOGO_MAX_BYTES } from "@/lib/logo-upload-policy";
import { notifyStorageChanged } from "@/lib/storage-usage";

// /app/organization/branding (1-9C) : lecture pour tout membre actif,
// édition réservée à `branding.manage`. Champs interdits (slug/currency/
// status/logoKey/organizationId) ne sont JAMAIS envoyés — seuls
// name/brandColor/logo transitent, whitelist stricte côté backend.
export default function OrganizationBrandingPage() {
  // 1-15C : après une modification, seule l'organisation est relue (le
  // contexte, l'outbox et le socket ne sont pas concernés).
  const { t } = useT("organization");
  const { t: tc } = useT("common");
  const { organization, authContext, refreshOrganization } =
    useOrganizationShell();
  const canManage =
    authContext?.effectivePermissions.includes("branding.manage");

  const [name, setName] = useState("");
  const [brandColor, setBrandColor] = useState("#000000");
  const [logo, setLogo] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removingLogo, setRemovingLogo] = useState(false);
  const [error, setError] = useMessage("organization");

  // Réhydrate le formulaire quand l'organisation chargée change (initial
  // chargement, après sa propre modification ou celle d'un collègue,
  // 1-15C) — jamais dans un effet séparé sur
  // `logo`/`brandColor` (ceux-ci sont purement locaux tant que non soumis).
  useEffect(() => {
    if (!organization) return;
    setName(organization.name);
    setBrandColor(organization.brandColor);
  }, [organization]);

  useEffect(() => {
    if (!logo) {
      setLogoPreview(null);
      return;
    }
    const url = URL.createObjectURL(logo);
    setLogoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [logo]);

  if (!organization) {
    return (
      <p className="text-sm text-muted-foreground">
        {tc("shell.organizationUnavailable")}
      </p>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManage) return;
    setError(null);
    setSaving(true);
    try {
      const updated = await updateOrganizationBranding({
        name: name !== organization.name ? name : undefined,
        brandColor:
          brandColor !== organization.brandColor ? brandColor : undefined,
        logo: logo ?? undefined,
      });
      const sentLogo = logo !== null;
      setLogo(null);
      refreshOrganization();
      // 1-17B : occupation du stockage relue (logo compté dans le quota).
      if (sentLogo) notifyStorageChanged();
      toast.success(t("branding.updated"));
      if (updated.storageCleanup === "failed") {
        toast.warning(t("branding.oldLogoNotDeleted"));
      }
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveLogo = async () => {
    if (!canManage) return;
    setError(null);
    setRemovingLogo(true);
    try {
      const removed = await removeOrganizationLogo();
      refreshOrganization();
      notifyStorageChanged();
      toast.success(t("branding.logoRemoved"));
      if (removed.storageCleanup === "failed") {
        toast.warning(t("branding.oldLogoNotDeleted"));
      }
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setRemovingLogo(false);
    }
  };

  const previewSrc = logoPreview ?? organization.logoUrl;

  return (
    <div className="max-w-lg space-y-6">
      <div className="flex items-center gap-4">
        <div
          className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted"
          style={{ borderColor: brandColor }}
        >
          {previewSrc ? (
            <Image
              src={previewSrc}
              alt={t("branding.logoAlt")}
              width={64}
              height={64}
              className="h-full w-full object-cover"
              unoptimized
            />
          ) : (
            <span className="text-xs text-muted-foreground">
              {t("branding.noLogo")}
            </span>
          )}
        </div>
        <span
          className="h-8 w-8 shrink-0 rounded-full border"
          style={{ backgroundColor: brandColor }}
          aria-label={t("branding.colorLabel", { color: brandColor })}
        />
        {canManage && organization.logoUrl && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={removingLogo}
            onClick={() => void handleRemoveLogo()}
          >
            {removingLogo ? t("deleting") : t("branding.removeLogo")}
          </Button>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {canManage ? (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="org-name">{t("branding.name")}</Label>
            <Input
              id="org-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              // 1-12C : limite des nouvelles saisies ; un nom historique plus
              // long reste affiché tel quel et n'est renvoyé que s'il change.
              maxLength={ORGANIZATION_NAME_MAX_LENGTH}
              aria-describedby="org-name-hint"
              required
            />
            <p id="org-name-hint" className="text-xs text-muted-foreground">
              {tc("fields.maxLength", { count: ORGANIZATION_NAME_MAX_LENGTH })}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="org-color">{t("branding.color")}</Label>
            <Input
              id="org-color"
              type="color"
              value={brandColor}
              onChange={(e) => setBrandColor(e.target.value)}
              className="h-10 w-20 p-1"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="org-logo">{t("branding.logo")}</Label>
            <Input
              id="org-logo"
              type="file"
              accept={LOGO_ACCEPT}
              aria-describedby="org-logo-hint"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                // Pré-contrôle de confort (le backend valide contenu, format
                // réel et dimensions) : évite un envoi manifestement refusé.
                if (file && file.size > LOGO_MAX_BYTES) {
                  setError((tr) => tr("branding.logoTooLarge"));
                  e.target.value = "";
                  setLogo(null);
                  return;
                }
                setError(null);
                setLogo(file);
              }}
            />
            <p id="org-logo-hint" className="text-xs text-muted-foreground">
              {t("branding.logoHelp")}
            </p>
          </div>
          <Button type="submit" disabled={saving}>
            {saving ? t("saving") : t("actions.save")}
          </Button>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("branding.readOnly")}
        </p>
      )}
    </div>
  );
}
