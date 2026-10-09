"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { toast } from "sonner";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import { getApiErrorCode, getApiErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StoredImage } from "@/components/products/stored-image";
import { useOnlineStatus } from "@/hooks/use-online-status";
import type {
  ApiProduct,
  StorageCleanup,
  UpdateProductPayload,
} from "@/lib/api";
import {
  PRODUCT_PHOTO_ACCEPT,
  notifyStorageChanged,
  productPhotoProblem,
} from "@/lib/storage-usage";

interface UpdateProductDialogProps {
  product: ApiProduct | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  // `products.manage` : nom et photo (1-17B : ajout ou remplacement ; l'API
  // exige la même permission pour toute photo envoyée).
  canManageDescription: boolean;
  // `stock.adjust` : prix d'achat/vente + stock additionnel.
  canAdjustStock: boolean;
  onUpdated: (
    id: string,
    payload: UpdateProductPayload,
  ) => Promise<{ storageCleanup?: StorageCleanup } | void>;
}

export function UpdateProductDialog({
  product,
  open,
  onOpenChange,
  canManageDescription,
  canAdjustStock,
  onUpdated,
}: UpdateProductDialogProps) {
  const { t } = useT("catalog");
  const format = useFormat();
  const online = useOnlineStatus();
  const [name, setName] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [salePrice, setSalePrice] = useState("");
  const [additionalStock, setAdditionalStock] = useState("");
  const [loading, setLoading] = useState(false);
  // 1-17B — photo choisie (jamais envoyée avant « Enregistrer »), aperçu
  // local et erreur propre au champ. L'ancienne photo reste affichée et en
  // place côté serveur tant que l'enregistrement n'a pas réussi.
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const canEditAnything = canManageDescription || canAdjustStock;
  // 1-12H : le prix d'achat n'est proposé que s'il est visible
  // (`products.view_financials`) — jamais saisi « à l'aveugle » ni prérempli
  // par une valeur inventée.
  const purchasePriceVisible = product?.purchasePrice !== undefined;

  const clearPhoto = () => {
    setPhoto(null);
    setPhotoError(null);
    if (photoInput.current) photoInput.current.value = "";
  };

  // Sync fields whenever the targeted product changes
  useEffect(() => {
    if (product) {
      setName(product.name);
      setPurchasePrice(
        product.purchasePrice !== undefined
          ? String(product.purchasePrice)
          : "",
      );
      setSalePrice(String(product.salePrice));
      setAdditionalStock("");
    }
    // Autre cible : aucune photo choisie n'est conservée.
    setPhoto(null);
    setPhotoError(null);
  }, [product]);

  useEffect(() => {
    if (!photo) {
      setPhotoPreview(null);
      return;
    }
    const url = URL.createObjectURL(photo);
    setPhotoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const handleOpenChange = (v: boolean) => {
    // Jamais fermé pendant l'envoi ; fermé sans enregistrer : choix annulé.
    if (loading) return;
    if (!v) clearPhoto();
    onOpenChange(v);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!product || loading) return;

    // Construction explicite du payload : un champ non autorisé n'est
    // JAMAIS ajouté, même si sa valeur locale est restée identique à
    // l'originale — la permission borne le payload avant tout diff.
    const payload: UpdateProductPayload = {};
    if (canManageDescription && name !== product.name) {
      payload.name = name;
    }
    if (canAdjustStock) {
      if (
        product.purchasePrice !== undefined &&
        purchasePrice !== String(product.purchasePrice)
      ) {
        payload.purchasePrice = parseFloat(purchasePrice);
      }
      if (salePrice !== String(product.salePrice)) {
        payload.salePrice = parseFloat(salePrice);
      }
      const qty = parseInt(additionalStock, 10);
      if (!isNaN(qty) && qty > 0) {
        payload.additionalStock = qty;
      }
    }
    const sendsPhoto = canManageDescription && photo !== null;
    if (sendsPhoto) {
      if (!online) {
        setPhotoError(t("product.photoOffline"));
        return;
      }
      payload.image = photo;
    }

    if (Object.keys(payload).length === 0) {
      toast.error(t("product.noChange"));
      return;
    }

    setLoading(true);
    setPhotoError(null);
    try {
      const result = await onUpdated(product._id, payload);
      toast.success(
        sendsPhoto ? t("product.photoUpdated") : t("product.updated"),
      );
      if (result && result.storageCleanup === "failed") {
        toast.warning(t("product.oldPhotoNotDeleted"));
      }
      if (sendsPhoto) notifyStorageChanged();
      clearPhoto();
      onOpenChange(false);
    } catch (err: unknown) {
      const message = getApiErrorMessage(err);
      const code = getApiErrorCode(err);
      // Erreur liée à la photo (quota, format, conflit) : affichée sous le
      // champ, la sélection est conservée pour réessayer ou annuler.
      if (
        sendsPhoto &&
        (code?.startsWith("PRODUCT_IMAGE_") || code?.startsWith("STORAGE_"))
      ) {
        setPhotoError(message);
      } else {
        toast.error(message);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("product.updateTitle")}</DialogTitle>
        </DialogHeader>
        {product && !canEditAnything && (
          <p className="text-sm text-muted-foreground">
            {t("product.noPermission")}
          </p>
        )}
        {product && canEditAnything && (
          <form onSubmit={handleSubmit} className="space-y-4 mt-2">
            {canManageDescription && (
              <div className="space-y-2">
                <Label htmlFor="u-name">{t("product.nameShort")}</Label>
                <Input
                  id="u-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
            )}
            {canManageDescription && (
              <fieldset className="space-y-2" disabled={loading}>
                <legend className="text-sm font-medium">
                  {product.imageUrl
                    ? t("product.photoReplace")
                    : t("product.photoAdd")}
                </legend>
                <div className="flex items-start gap-3">
                  <figure className="shrink-0 space-y-1">
                    <div className="relative h-20 w-20 overflow-hidden rounded-md bg-muted">
                      {photoPreview ? (
                        <Image
                          src={photoPreview}
                          alt={t("product.photoPreview")}
                          fill
                          sizes="80px"
                          className="object-cover"
                          unoptimized
                        />
                      ) : (
                        <StoredImage
                          src={product.imageUrl}
                          alt={t("product.photoCurrent")}
                          lazy={false}
                        />
                      )}
                    </div>
                    <figcaption className="w-20 text-center text-[11px] text-muted-foreground">
                      {photoPreview
                        ? t("product.photoPreview")
                        : product.imageUrl
                          ? t("product.photoCurrent")
                          : t("product.photoNone")}
                    </figcaption>
                  </figure>
                  <div className="min-w-0 flex-1 space-y-2">
                    <Input
                      ref={photoInput}
                      id="u-photo"
                      type="file"
                      accept={PRODUCT_PHOTO_ACCEPT}
                      disabled={!online || loading}
                      aria-describedby="u-photo-help"
                      aria-invalid={photoError ? true : undefined}
                      onChange={(e) => {
                        const file = e.target.files?.[0] ?? null;
                        if (!file) {
                          setPhoto(null);
                          return;
                        }
                        // Pré-contrôle de confort ; l'API contrôle le
                        // contenu réel (format, décodage, dimensions).
                        const problem = productPhotoProblem(file);
                        if (problem) {
                          setPhoto(null);
                          e.target.value = "";
                          setPhotoError(
                            problem === "size"
                              ? t("product.photoTooLarge")
                              : t("product.photoInvalidType"),
                          );
                          return;
                        }
                        setPhotoError(null);
                        setPhoto(file);
                      }}
                    />
                    {photo && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={clearPhoto}
                      >
                        {t("product.photoCancel")}
                      </Button>
                    )}
                  </div>
                </div>
                <p id="u-photo-help" className="text-xs text-muted-foreground">
                  {online ? t("product.photoHelp") : t("product.photoOffline")}
                </p>
                {photoError && (
                  <p role="alert" className="text-sm text-destructive">
                    {photoError}
                  </p>
                )}
              </fieldset>
            )}
            {canAdjustStock && (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {purchasePriceVisible && (
                    <div className="space-y-2">
                      <Label htmlFor="u-buy">
                        {t("product.purchasePrice")}
                      </Label>
                      <Input
                        id="u-buy"
                        type="number"
                        min="0"
                        step="1"
                        value={purchasePrice}
                        onChange={(e) => setPurchasePrice(e.target.value)}
                        required
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("product.current", {
                          amount: format.fcfa(product.purchasePrice ?? 0),
                        })}
                      </p>
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="u-sell">{t("product.salePrice")}</Label>
                    <Input
                      id="u-sell"
                      type="number"
                      min="0"
                      step="1"
                      value={salePrice}
                      onChange={(e) => setSalePrice(e.target.value)}
                      required
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("product.current", {
                        amount: format.fcfa(product.salePrice),
                      })}
                    </p>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="u-stock">
                    {t("product.additionalStock")}
                  </Label>
                  <Input
                    id="u-stock"
                    type="number"
                    min="1"
                    step="1"
                    value={additionalStock}
                    onChange={(e) => setAdditionalStock(e.target.value)}
                    placeholder="0"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("product.remaining", {
                      count: product.remainingQuantity,
                    })}
                    {product.unitsSold !== undefined &&
                      ` · ${t("product.sold", { count: product.unitsSold })}`}
                  </p>
                </div>
              </>
            )}
            <Button
              type="submit"
              className="w-full"
              disabled={loading}
              aria-busy={loading}
            >
              {loading
                ? photo
                  ? t("product.photoUploading")
                  : t("updating")
                : t("actions.save")}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
