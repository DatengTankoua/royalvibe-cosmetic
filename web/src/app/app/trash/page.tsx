"use client";

import { useState } from "react";
import {
  Trash2Icon,
  RotateCcwIcon,
  FolderIcon,
  PackageIcon,
  CheckSquareIcon,
  SquareIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import { rich } from "@/i18n/rich";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import { hasPermission } from "@/lib/organization-permissions";
import { useTrash } from "@/hooks/use-trash";
import { getApiErrorMessage } from "@/lib/api";
import { StoredImage } from "@/components/products/stored-image";

type ConfirmAction =
  | { kind: "restore-section"; id: string; name: string }
  | { kind: "delete-section"; id: string; name: string }
  | { kind: "restore-product"; id: string; name: string }
  | { kind: "delete-product"; id: string; name: string }
  | { kind: "bulk-restore-sections"; ids: string[] }
  | { kind: "bulk-delete-sections"; ids: string[] }
  | { kind: "bulk-restore-products"; ids: string[] }
  | { kind: "bulk-delete-products"; ids: string[] };

// /app/trash (1-9D, ex "/corbeille") : `trash.manage` gate `GET /trash` côté
// backend — `useTrash(enabled)` n'appelle l'API que si cette permission est
// confirmée (jamais un 403 provoqué volontairement). Jamais `User.role`.
export default function TrashPage() {
  const { t } = useT("catalog");
  const format = useFormat();
  const { authContext } = useOrganizationShell();
  const canManage = hasPermission(authContext, "trash.manage");
  const {
    sections,
    products,
    isLoading,
    error,
    reload,
    doRestoreSection,
    doPermanentDeleteSection,
    doRestoreProduct,
    doPermanentDeleteProduct,
    doBulkRestoreSections,
    doBulkDeleteSections,
    doBulkRestoreProducts,
    doBulkDeleteProducts,
  } = useTrash(canManage);

  const [selectedSections, setSelectedSections] = useState<Set<string>>(
    new Set(),
  );
  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(
    new Set(),
  );
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);

  if (authContext && !canManage) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-10 sm:px-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Trash2Icon className="h-6 w-6 text-muted-foreground" />
          {t("trash.title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("trash.noPermission")}
        </p>
      </div>
    );
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  const toggleSection = (id: string) => {
    setSelectedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllSections = () => {
    setSelectedSections(
      selectedSections.size === sections.length
        ? new Set()
        : new Set(sections.map((s) => s._id)),
    );
  };

  const toggleProduct = (id: string) => {
    setSelectedProducts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllProducts = () => {
    setSelectedProducts(
      selectedProducts.size === products.length
        ? new Set()
        : new Set(products.map((p) => p._id)),
    );
  };

  // ── execute confirmed action ───────────────────────────────────────────────

  const executeConfirm = async () => {
    if (!confirm) return;
    try {
      switch (confirm.kind) {
        case "restore-section":
          await doRestoreSection(confirm.id);
          toast.success(
            t("trash.toast.sectionRestored", { name: confirm.name }),
          );
          break;
        case "delete-section":
          await doPermanentDeleteSection(confirm.id);
          toast.success(
            t("trash.toast.sectionDeleted", { name: confirm.name }),
          );
          break;
        case "restore-product":
          await doRestoreProduct(confirm.id);
          toast.success(
            t("trash.toast.productRestored", { name: confirm.name }),
          );
          break;
        case "delete-product": {
          const cleanup = await doPermanentDeleteProduct(confirm.id);
          toast.success(
            t("trash.toast.productDeleted", { name: confirm.name }),
          );
          // R2 privé : jamais annoncer l'effacement d'une photo restée.
          if (cleanup === "failed") {
            toast.warning(t("trash.toast.photoNotDeleted"));
          }
          break;
        }
        case "bulk-restore-sections":
          await doBulkRestoreSections(confirm.ids);
          toast.success(
            t("trash.toast.sectionsRestored", { count: confirm.ids.length }),
          );
          setSelectedSections(new Set());
          break;
        case "bulk-delete-sections":
          await doBulkDeleteSections(confirm.ids);
          toast.success(
            t("trash.toast.sectionsDeleted", { count: confirm.ids.length }),
          );
          setSelectedSections(new Set());
          break;
        case "bulk-restore-products":
          await doBulkRestoreProducts(confirm.ids);
          toast.success(
            t("trash.toast.productsRestored", { count: confirm.ids.length }),
          );
          setSelectedProducts(new Set());
          break;
        case "bulk-delete-products": {
          const failed = await doBulkDeleteProducts(confirm.ids);
          toast.success(
            t("trash.toast.productsDeleted", { count: confirm.ids.length }),
          );
          if (failed > 0) {
            toast.warning(t("trash.toast.photosNotDeleted", { count: failed }));
          }
          setSelectedProducts(new Set());
          break;
        }
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setConfirm(null);
    }
  };

  // ── confirm dialog text ────────────────────────────────────────────────────

  const confirmTitle = () => {
    if (!confirm) return "";
    switch (confirm.kind) {
      case "restore-section":
        return t("trash.confirm.restoreSectionTitle");
      case "delete-section":
        return t("trash.confirm.deleteSectionTitle");
      case "restore-product":
        return t("trash.confirm.restoreProductTitle");
      case "delete-product":
        return t("trash.confirm.deleteProductTitle");
      case "bulk-restore-sections":
        return t("trash.confirm.bulkRestoreSectionsTitle", {
          count: confirm.ids.length,
        });
      case "bulk-delete-sections":
        return t("trash.confirm.bulkDeleteSectionsTitle", {
          count: confirm.ids.length,
        });
      case "bulk-restore-products":
        return t("trash.confirm.bulkRestoreProductsTitle", {
          count: confirm.ids.length,
        });
      case "bulk-delete-products":
        return t("trash.confirm.bulkDeleteProductsTitle", {
          count: confirm.ids.length,
        });
    }
  };

  const confirmDesc = () => {
    if (!confirm) return "";
    switch (confirm.kind) {
      case "restore-section":
      case "delete-section":
      case "restore-product":
      case "delete-product": {
        const name = confirm.name;
        const key = {
          "restore-section": "trash.confirm.restoreSectionText",
          "delete-section": "trash.confirm.deleteSectionText",
          "restore-product": "trash.confirm.restoreProductText",
          "delete-product": "trash.confirm.deleteProductText",
        } as const;
        // Nom saisi : rendu à part, jamais interprété dans le gabarit.
        return rich(t(key[confirm.kind]), {
          name: () => <strong>{name}</strong>,
        });
      }
      case "bulk-restore-sections":
        return t("trash.confirm.bulkRestoreSectionsText", {
          count: confirm.ids.length,
        });
      case "bulk-delete-sections":
        return t("trash.confirm.bulkDeleteSectionsText", {
          count: confirm.ids.length,
        });
      case "bulk-restore-products":
        return t("trash.confirm.bulkRestoreProductsText", {
          count: confirm.ids.length,
        });
      case "bulk-delete-products":
        return t("trash.confirm.bulkDeleteProductsText", {
          count: confirm.ids.length,
        });
    }
  };

  const isDestructive =
    confirm?.kind === "delete-section" ||
    confirm?.kind === "delete-product" ||
    confirm?.kind === "bulk-delete-sections" ||
    confirm?.kind === "bulk-delete-products";

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-10">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Trash2Icon className="h-6 w-6 text-muted-foreground" />
            {t("trash.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("trash.subtitle")}</p>
        </div>

        {isLoading && (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        )}
        {!isLoading && error && (
          <div className="flex items-center gap-3">
            <p className="text-sm text-destructive">{error}</p>
            <button
              onClick={() => void reload()}
              className="text-sm text-primary underline underline-offset-2 hover:no-underline"
            >
              {t("actions.retry")}
            </button>
          </div>
        )}

        {/* ── Catalogues ── */}
        {!isLoading && (
          <section className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-medium">
                <FolderIcon className="h-5 w-5" />
                {t("trash.sections", { count: sections.length })}
              </h2>
              {sections.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={toggleAllSections}
                    className="text-muted-foreground"
                  >
                    {selectedSections.size === sections.length ? (
                      <CheckSquareIcon className="h-4 w-4 mr-1" />
                    ) : (
                      <SquareIcon className="h-4 w-4 mr-1" />
                    )}
                    {t("trash.selectAll")}
                  </Button>
                  {selectedSections.size > 0 && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setConfirm({
                            kind: "bulk-restore-sections",
                            ids: [...selectedSections],
                          })
                        }
                      >
                        <RotateCcwIcon className="h-4 w-4 mr-1" />
                        {t("trash.restoreCount", {
                          count: selectedSections.size,
                        })}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() =>
                          setConfirm({
                            kind: "bulk-delete-sections",
                            ids: [...selectedSections],
                          })
                        }
                      >
                        <Trash2Icon className="h-4 w-4 mr-1" />
                        {t("trash.deleteCount", {
                          count: selectedSections.size,
                        })}
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>

            {sections.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("trash.noSections")}
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {sections.map((s) => (
                  <Card
                    key={s._id}
                    className={`transition-shadow hover:shadow-md ${selectedSections.has(s._id) ? "ring-2 ring-primary" : ""}`}
                  >
                    <CardHeader className="pb-2">
                      <div className="flex items-start gap-2">
                        <button
                          onClick={() => toggleSection(s._id)}
                          aria-pressed={selectedSections.has(s._id)}
                          aria-label={t("trash.select", { name: s.name })}
                          className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                        >
                          {selectedSections.has(s._id) ? (
                            <CheckSquareIcon className="h-4 w-4" />
                          ) : (
                            <SquareIcon className="h-4 w-4" />
                          )}
                        </button>
                        <div className="flex-1 min-w-0">
                          <Link
                            prefetch={false}
                            href={`/app/catalog/${s._id}`}
                            className="block"
                          >
                            <CardTitle className="text-sm truncate">
                              {s.name}
                            </CardTitle>
                            {s.description && (
                              <CardDescription className="text-xs line-clamp-1">
                                {s.description}
                              </CardDescription>
                            )}
                          </Link>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <p className="text-xs text-muted-foreground mb-3">
                        {t("trash.deletedOn", {
                          date: format.date(s.deletedAt),
                        })}
                      </p>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1"
                          onClick={() =>
                            setConfirm({
                              kind: "restore-section",
                              id: s._id,
                              name: s.name,
                            })
                          }
                        >
                          <RotateCcwIcon className="h-3 w-3 mr-1" />
                          {t("trash.restore")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          aria-label={t("trash.deletePermanently")}
                          onClick={() =>
                            setConfirm({
                              kind: "delete-section",
                              id: s._id,
                              name: s.name,
                            })
                          }
                        >
                          <Trash2Icon className="h-4 w-4" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </section>
        )}

        {/* ── Produits ── */}
        {!isLoading && (
          <section className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-medium">
                <PackageIcon className="h-5 w-5" />
                {t("trash.products", { count: products.length })}
              </h2>
              {products.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={toggleAllProducts}
                    className="text-muted-foreground"
                  >
                    {selectedProducts.size === products.length ? (
                      <CheckSquareIcon className="h-4 w-4 mr-1" />
                    ) : (
                      <SquareIcon className="h-4 w-4 mr-1" />
                    )}
                    {t("trash.selectAll")}
                  </Button>
                  {selectedProducts.size > 0 && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setConfirm({
                            kind: "bulk-restore-products",
                            ids: [...selectedProducts],
                          })
                        }
                      >
                        <RotateCcwIcon className="h-4 w-4 mr-1" />
                        {t("trash.restoreCount", {
                          count: selectedProducts.size,
                        })}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() =>
                          setConfirm({
                            kind: "bulk-delete-products",
                            ids: [...selectedProducts],
                          })
                        }
                      >
                        <Trash2Icon className="h-4 w-4 mr-1" />
                        {t("trash.deleteCount", {
                          count: selectedProducts.size,
                        })}
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>

            {products.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("trash.noProducts")}
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {products.map((p) => (
                  <Card
                    key={p._id}
                    className={`transition-shadow hover:shadow-md ${selectedProducts.has(p._id) ? "ring-2 ring-primary" : ""}`}
                  >
                    <Link
                      prefetch={false}
                      href={`/app/catalog/products/${p._id}`}
                      className="relative block aspect-video overflow-hidden bg-muted"
                    >
                      <StoredImage src={p.imageUrl} alt={p.name} />
                    </Link>
                    <CardHeader className="pb-2">
                      <div className="flex items-start gap-2">
                        <button
                          onClick={() => toggleProduct(p._id)}
                          aria-pressed={selectedProducts.has(p._id)}
                          aria-label={t("trash.select", { name: p.name })}
                          className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                        >
                          {selectedProducts.has(p._id) ? (
                            <CheckSquareIcon className="h-4 w-4" />
                          ) : (
                            <SquareIcon className="h-4 w-4" />
                          )}
                        </button>
                        <div className="flex-1 min-w-0">
                          <CardTitle className="text-sm truncate">
                            {p.name}
                          </CardTitle>
                          <CardDescription className="text-xs">
                            {/* 1-12H : prix d'achat seulement s'il est
                                projeté (products.view_financials). */}
                            {p.purchasePrice !== undefined &&
                              `${t("trash.purchase", { amount: format.fcfa(p.purchasePrice) })} · `}
                            {t("trash.sale", {
                              amount: format.fcfa(p.salePrice),
                            })}
                          </CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <p className="text-xs text-muted-foreground mb-3">
                        {t("trash.deletedOn", {
                          date: format.date(p.deletedAt),
                        })}
                      </p>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1"
                          onClick={() =>
                            setConfirm({
                              kind: "restore-product",
                              id: p._id,
                              name: p.name,
                            })
                          }
                        >
                          <RotateCcwIcon className="h-3 w-3 mr-1" />
                          {t("trash.restore")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          aria-label={t("trash.deletePermanently")}
                          onClick={() =>
                            setConfirm({
                              kind: "delete-product",
                              id: p._id,
                              name: p.name,
                            })
                          }
                        >
                          <Trash2Icon className="h-4 w-4" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      {/* ── Modal de confirmation global ── */}
      <AlertDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmTitle()}</AlertDialogTitle>
            <AlertDialogDescription>
              <span>{confirmDesc()}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className={
                isDestructive
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : ""
              }
              onClick={() => void executeConfirm()}
            >
              {isDestructive
                ? t("trash.deletePermanently")
                : t("trash.restore")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
