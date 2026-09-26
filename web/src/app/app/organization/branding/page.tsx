"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { toast } from "sonner";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getApiErrorMessage,
  removeOrganizationLogo,
  updateOrganizationBranding,
} from "@/lib/api";

// /app/organization/branding (1-9C) : lecture pour tout membre actif,
// édition réservée à `branding.manage`. Champs interdits (slug/currency/
// status/logoKey/organizationId) ne sont JAMAIS envoyés — seuls
// name/brandColor/logo transitent, whitelist stricte côté backend.
export default function OrganizationBrandingPage() {
  const { organization, authContext, refreshShell } = useOrganizationShell();
  const canManage =
    authContext?.effectivePermissions.includes("branding.manage");

  const [name, setName] = useState("");
  const [brandColor, setBrandColor] = useState("#000000");
  const [logo, setLogo] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removingLogo, setRemovingLogo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Réhydrate le formulaire quand l'organisation chargée change (initial
  // chargement ou après un refreshShell) — jamais dans un effet séparé sur
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
        Organisation actuelle indisponible.
      </p>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManage) return;
    setError(null);
    setSaving(true);
    try {
      await updateOrganizationBranding({
        name: name !== organization.name ? name : undefined,
        brandColor:
          brandColor !== organization.brandColor ? brandColor : undefined,
        logo: logo ?? undefined,
      });
      setLogo(null);
      refreshShell();
      toast.success("Branding mis à jour");
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
      await removeOrganizationLogo();
      refreshShell();
      toast.success("Logo supprimé");
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
              alt="Logo de l'organisation"
              width={64}
              height={64}
              className="h-full w-full object-cover"
              unoptimized
            />
          ) : (
            <span className="text-xs text-muted-foreground">Aucun logo</span>
          )}
        </div>
        <span
          className="h-8 w-8 shrink-0 rounded-full border"
          style={{ backgroundColor: brandColor }}
          aria-label={`Couleur ${brandColor}`}
        />
        {canManage && organization.logoUrl && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={removingLogo}
            onClick={() => void handleRemoveLogo()}
          >
            {removingLogo ? "Suppression…" : "Supprimer le logo"}
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
            <Label htmlFor="org-name">Nom de l&apos;organisation</Label>
            <Input
              id="org-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="org-color">Couleur de marque</Label>
            <Input
              id="org-color"
              type="color"
              value={brandColor}
              onChange={(e) => setBrandColor(e.target.value)}
              className="h-10 w-20 p-1"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="org-logo">Logo (optionnel)</Label>
            <Input
              id="org-logo"
              type="file"
              accept="image/*"
              onChange={(e) => setLogo(e.target.files?.[0] ?? null)}
            />
          </div>
          <Button type="submit" disabled={saving}>
            {saving ? "Enregistrement…" : "Enregistrer"}
          </Button>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">
          Lecture seule — la modification du branding nécessite la permission «
          Gérer le branding ».
        </p>
      )}
    </div>
  );
}
