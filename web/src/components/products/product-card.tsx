"use client";

import { Fragment, useState } from "react";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import { rich } from "@/i18n/rich";
import Link from "next/link";
import Image from "next/image";
import {
  BadgeCheckIcon,
  AlertTriangleIcon,
  XCircleIcon,
  Trash2Icon,
  PencilIcon,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { useIndicativeStock } from "@/contexts/offline-sales-context";
import type { ApiProduct } from "@/lib/api";
import { productInfoItems, type ProductInfoKey } from "@/lib/product-info";

// 1-16G : libellés dans `catalog` (`status.*`).
const STATUS_CONFIG = {
  in_stock: { icon: BadgeCheckIcon, variant: "default" as const },
  low_stock: { icon: AlertTriangleIcon, variant: "secondary" as const },
  out_of_stock: { icon: XCircleIcon, variant: "destructive" as const },
};

// 1-12H : sous-ensemble compact de la fiche, même source de calcul ; seuls
// les champs présents dans la réponse projetée sont rendus.
const CARD_KEYS: readonly ProductInfoKey[] = [
  "salePrice",
  "stock",
  "initialQuantity",
  "unitsSold",
  "purchasePrice",
  "actualProfit",
];

interface ProductCardProps {
  product: ApiProduct;
  canEdit: boolean;
  canDelete: boolean;
  priority?: boolean;
  // Début de la requête serveur ayant fourni `product` (1-11C.3).
  serverLoadedAt?: number;
  onDelete: (id: string) => void;
  onEdit: (product: ApiProduct) => void;
}

export function ProductCard({
  product,
  canEdit,
  canDelete,
  priority = false,
  serverLoadedAt,
  onDelete,
  onEdit,
}: ProductCardProps) {
  const { t } = useT("catalog");
  const { fcfa } = useFormat();
  const status = STATUS_CONFIG[product.status] ? product.status : "in_stock";
  const cfg = STATUS_CONFIG[status];
  const StatusIcon = cfg.icon;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmEdit, setConfirmEdit] = useState(false);
  // 1-11C.3 : stock serveur moins ventes locales non confirmées (≥ 0).
  const indicative = useIndicativeStock(
    product._id,
    product.remainingQuantity,
    serverLoadedAt,
  );

  return (
    <>
      <Card className="overflow-hidden hover:shadow-md transition-shadow">
        <Link
          prefetch={false}
          href={`/app/catalog/products/${product._id}`}
          className="relative block aspect-video overflow-hidden bg-muted"
        >
          <Image
            src={product.imageUrl}
            alt={product.name}
            fill
            unoptimized
            priority={priority}
            loading={priority ? "eager" : "lazy"}
            className="object-cover"
          />
        </Link>

        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="text-sm leading-tight">
              <Link
                prefetch={false}
                href={`/app/catalog/products/${product._id}`}
                className="hover:underline"
              >
                {product.name}
              </Link>
            </CardTitle>
            <Badge variant={cfg.variant} className="shrink-0 text-xs">
              <StatusIcon className="mr-1 h-3 w-3" />
              {t(`status.${status}`)}
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="space-y-2 text-sm">
          <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
            {productInfoItems(product, indicative, { t, fcfa })
              .filter((item) => CARD_KEYS.includes(item.key))
              .map((item) => (
                <Fragment key={item.key}>
                  <span className="text-muted-foreground">{item.label}</span>
                  <span
                    className={`text-right font-medium ${
                      item.tone === "positive"
                        ? "text-green-700 dark:text-green-400"
                        : item.tone === "negative"
                          ? "text-red-600 dark:text-red-400"
                          : ""
                    }`}
                  >
                    {item.value}
                  </span>
                </Fragment>
              ))}
          </div>

          {(canEdit || canDelete) && (
            <div className="flex gap-2 pt-1">
              {canEdit && (
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => setConfirmEdit(true)}
                >
                  <PencilIcon className="h-3 w-3 mr-1" />
                  {t("product.edit")}
                </Button>
              )}
              {canDelete && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setConfirmDelete(true)}
                  aria-label={t("product.trashAction")}
                >
                  <Trash2Icon className="h-4 w-4" />
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Confirmation suppression */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("product.trashTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {rich(t("product.trashText"), {
                name: () => <strong>{product.name}</strong>,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => onDelete(product._id)}
            >
              {t("product.trashAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirmation modification */}
      <AlertDialog open={confirmEdit} onOpenChange={setConfirmEdit}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("product.editTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {rich(t("product.editText"), {
                name: () => <strong>{product.name}</strong>,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmEdit(false);
                onEdit(product);
              }}
            >
              {t("actions.continue")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
