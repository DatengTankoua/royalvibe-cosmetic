"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Trash2Icon,
  RotateCcwIcon,
  FolderIcon,
  PackageIcon,
  CheckSquareIcon,
  SquareIcon,
} from "lucide-react";
import { toast } from "sonner";
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
import { useAuth } from "@/contexts/auth-context";
import { useTrash } from "@/hooks/use-trash";
import { fmtXof } from "@/lib/currency";
import Image from "next/image";

type ConfirmAction =
  | { kind: "restore-section"; id: string; name: string }
  | { kind: "delete-section"; id: string; name: string }
  | { kind: "restore-product"; id: string; name: string }
  | { kind: "delete-product"; id: string; name: string }
  | { kind: "bulk-restore-sections"; ids: string[] }
  | { kind: "bulk-delete-sections"; ids: string[] }
  | { kind: "bulk-restore-products"; ids: string[] }
  | { kind: "bulk-delete-products"; ids: string[] };

export default function TrashPage() {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const {
    sections,
    products,
    isLoading,
    error,
    doRestoreSection,
    doPermanentDeleteSection,
    doRestoreProduct,
    doPermanentDeleteProduct,
    doBulkRestoreSections,
    doBulkDeleteSections,
    doBulkRestoreProducts,
    doBulkDeleteProducts,
  } = useTrash();

  const [selectedSections, setSelectedSections] = useState<Set<string>>(
    new Set(),
  );
  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(
    new Set(),
  );
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);

  useEffect(() => {
    if (!authLoading && (!user || user.role !== "admin"))
      router.push("/auth/login");
  }, [user, authLoading, router]);

  if (authLoading || !user || user.role !== "admin") return null;

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
          toast.success(`Catalogue « ${confirm.name} » restauré`);
          break;
        case "delete-section":
          await doPermanentDeleteSection(confirm.id);
          toast.success(
            `Catalogue « ${confirm.name} » supprimé définitivement`,
          );
          break;
        case "restore-product":
          await doRestoreProduct(confirm.id);
          toast.success(`Produit « ${confirm.name} » restauré`);
          break;
        case "delete-product":
          await doPermanentDeleteProduct(confirm.id);
          toast.success(`Produit « ${confirm.name} » supprimé définitivement`);
          break;
        case "bulk-restore-sections":
          await doBulkRestoreSections(confirm.ids);
          toast.success(`${confirm.ids.length} catalogue(s) restauré(s)`);
          setSelectedSections(new Set());
          break;
        case "bulk-delete-sections":
          await doBulkDeleteSections(confirm.ids);
          toast.success(
            `${confirm.ids.length} catalogue(s) supprimé(s) définitivement`,
          );
          setSelectedSections(new Set());
          break;
        case "bulk-restore-products":
          await doBulkRestoreProducts(confirm.ids);
          toast.success(`${confirm.ids.length} produit(s) restauré(s)`);
          setSelectedProducts(new Set());
          break;
        case "bulk-delete-products":
          await doBulkDeleteProducts(confirm.ids);
          toast.success(
            `${confirm.ids.length} produit(s) supprimé(s) définitivement`,
          );
          setSelectedProducts(new Set());
          break;
      }
    } catch {
      toast.error("Une erreur est survenue");
    } finally {
      setConfirm(null);
    }
  };

  // ── confirm dialog text ────────────────────────────────────────────────────

  const confirmTitle = () => {
    if (!confirm) return "";
    switch (confirm.kind) {
      case "restore-section":
        return "Restaurer ce catalogue ?";
      case "delete-section":
        return "Supprimer définitivement ce catalogue ?";
      case "restore-product":
        return "Restaurer ce produit ?";
      case "delete-product":
        return "Supprimer définitivement ce produit ?";
      case "bulk-restore-sections":
        return `Restaurer ${confirm.ids.length} catalogue(s) ?`;
      case "bulk-delete-sections":
        return `Supprimer ${confirm.ids.length} catalogue(s) définitivement ?`;
      case "bulk-restore-products":
        return `Restaurer ${confirm.ids.length} produit(s) ?`;
      case "bulk-delete-products":
        return `Supprimer ${confirm.ids.length} produit(s) définitivement ?`;
    }
  };

  const confirmDesc = () => {
    if (!confirm) return "";
    switch (confirm.kind) {
      case "restore-section":
        return (
          <>
            Le catalogue <strong>{confirm.name}</strong> sera remis dans le
            catalogue principal.
          </>
        );
      case "delete-section":
        return (
          <>
            Le catalogue <strong>{confirm.name}</strong> sera supprimé
            définitivement. Cette action est irréversible.
          </>
        );
      case "restore-product":
        return (
          <>
            Le produit <strong>{confirm.name}</strong> sera remis dans son
            catalogue.
          </>
        );
      case "delete-product":
        return (
          <>
            Le produit <strong>{confirm.name}</strong> sera supprimé
            définitivement avec son image. Cette action est irréversible.
          </>
        );
      case "bulk-restore-sections":
        return `Les ${confirm.ids.length} catalogue(s) sélectionné(s) seront restaurés.`;
      case "bulk-delete-sections":
        return `Les ${confirm.ids.length} catalogue(s) sélectionné(s) seront supprimés définitivement. Cette action est irréversible.`;
      case "bulk-restore-products":
        return `Les ${confirm.ids.length} produit(s) sélectionné(s) seront restaurés.`;
      case "bulk-delete-products":
        return `Les ${confirm.ids.length} produit(s) sélectionné(s) seront supprimés définitivement avec leurs images. Cette action est irréversible.`;
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
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-10">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Trash2Icon className="h-6 w-6 text-muted-foreground" />
            Corbeille
          </h1>
          <p className="text-sm text-muted-foreground">
            Les éléments supprimés peuvent être restaurés ou effacés
            définitivement.
          </p>
        </div>

        {isLoading && (
          <p className="text-sm text-muted-foreground">Chargement…</p>
        )}
        {!isLoading && error && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        {/* ── Catalogues ── */}
        {!isLoading && (
          <section className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-medium">
                <FolderIcon className="h-5 w-5" />
                Catalogues ({sections.length})
              </h2>
              {sections.length > 0 && (
                <div className="flex items-center gap-2">
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
                    Tout sélectionner
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
                        Restaurer ({selectedSections.size})
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
                        Supprimer ({selectedSections.size})
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>

            {sections.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Aucun catalogue dans la corbeille.
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
                          className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                        >
                          {selectedSections.has(s._id) ? (
                            <CheckSquareIcon className="h-4 w-4" />
                          ) : (
                            <SquareIcon className="h-4 w-4" />
                          )}
                        </button>
                        <div className="flex-1 min-w-0">
                          <Link href={`/sections/${s._id}`} className="block">
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
                        Supprimé le{" "}
                        {new Date(s.deletedAt).toLocaleDateString("fr-FR")}
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
                          Restaurer
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
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
                Produits ({products.length})
              </h2>
              {products.length > 0 && (
                <div className="flex items-center gap-2">
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
                    Tout sélectionner
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
                        Restaurer ({selectedProducts.size})
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
                        Supprimer ({selectedProducts.size})
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>

            {products.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Aucun produit dans la corbeille.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {products.map((p) => (
                  <Card
                    key={p._id}
                    className={`transition-shadow hover:shadow-md ${selectedProducts.has(p._id) ? "ring-2 ring-primary" : ""}`}
                  >
                    <Link
                      href={`/products/${p._id}`}
                      className="relative block aspect-video overflow-hidden bg-muted"
                    >
                      <Image
                        src={p.imageUrl}
                        alt={p.name}
                        fill
                        unoptimized
                        priority={false}
                        loading="lazy"
                        className="object-cover"
                      />
                    </Link>
                    <CardHeader className="pb-2">
                      <div className="flex items-start gap-2">
                        <button
                          onClick={() => toggleProduct(p._id)}
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
                            Achat : {fmtXof(p.purchasePrice)} · Vente :{" "}
                            {fmtXof(p.salePrice)}
                          </CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <p className="text-xs text-muted-foreground mb-3">
                        Supprimé le{" "}
                        {new Date(p.deletedAt).toLocaleDateString("fr-FR")}
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
                          Restaurer
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
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
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              className={
                isDestructive
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : ""
              }
              onClick={() => void executeConfirm()}
            >
              {isDestructive ? "Supprimer définitivement" : "Restaurer"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
