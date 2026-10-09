"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  flattenProductEvent,
  getApiErrorMessage,
  isNetworkError,
  type ApiProduct,
  type UpdateProductPayload,
} from "@/lib/api";
import { useSocket } from "@/contexts/socket-context";
import { useSaleInvalidation } from "@/hooks/use-sale-invalidation";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import { useImageRenewal } from "@/hooks/use-image-renewal";
import { createResponseOrder } from "@/lib/refresh-coordinator";
import { notifyStorageChanged } from "@/lib/storage-usage";

// 1-12H : les diffusions Socket.IO ne portent que les champs standard ; les
// champs étendus (selon les permissions) ne viennent que de l'API.
// 1-15A : toute diffusion produit ou vente concernant la liste déclenche une
// relecture SILENCIEUSE regroupée (`useLiveRefresh`), pour tous les membres :
// seule une lecture serveur réussie fait avancer `loadedAt` (1-11C.3), donc
// une fusion d'événement ne masque jamais une vente locale confirmée.

export function useProducts(sectionId?: string) {
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 1-11B : vraie panne réseau (aucune réponse) uniquement — jamais une
  // réponse HTTP (401/403/404/5xx) — seule éligible au repli hors ligne.
  const [isOffline, setIsOffline] = useState(false);
  const socket = useSocket();
  // 1-15A : une réponse périmée (requête plus ancienne arrivée en retard)
  // n'écrase jamais une liste plus récente.
  const order = useRef(createResponseOrder());
  // 1-15B : produits supprimés définitivement — jamais réaffichés par une
  // réponse retenue (identifiants non réutilisés).
  const purged = useRef(new Set<string>());

  // 1-11C.3 : début de la dernière requête RÉUSSIE — une vente locale
  // confirmée après cet instant n'est pas encore reflétée dans `products`.
  const [loadedAt, setLoadedAt] = useState<number | undefined>(undefined);

  const load = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!options.silent) setIsLoading(true);
      const requestedAt = Date.now();
      const ticket = order.current.begin();
      try {
        const data = await fetchProducts(sectionId);
        if (!order.current.accept(ticket)) return;
        setProducts(data.filter((p) => !purged.current.has(p._id)));
        setLoadedAt(requestedAt);
        setError(null);
        setIsOffline(false);
      } catch (err) {
        // Un rechargement silencieux en échec conserve la liste affichée.
        if (!options.silent) {
          setError(getApiErrorMessage(err));
          setIsOffline(isNetworkError(err));
        }
      } finally {
        if (!options.silent) setIsLoading(false);
      }
    },
    [sectionId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const scheduleRefresh = useLiveRefresh(
    () => load({ silent: true }),
    loadedAt,
  );
  // R2 privé : photo non chargeable (lien signé expiré) → relecture bornée.
  useImageRenewal(scheduleRefresh);

  useEffect(() => {
    if (!socket) return;
    // Payload standard `{ product, status }` : jamais de champ restreint.
    const onCreated = (data: Parameters<typeof flattenProductEvent>[0]) => {
      const p = flattenProductEvent(data);
      if (sectionId && p.sectionId !== sectionId) return;
      if (purged.current.has(p._id)) return;
      setProducts((prev) =>
        prev.some((x) => x._id === p._id) ? prev : [p, ...prev],
      );
      scheduleRefresh();
    };
    const onUpdated = (data: Parameters<typeof flattenProductEvent>[0]) => {
      const common = flattenProductEvent(data);
      // Fusion des seuls champs standard : les champs étendus déjà chargés
      // sont conservés jusqu'au rechargement autorisé.
      setProducts((prev) =>
        prev.map((x) => (x._id === common._id ? { ...x, ...common } : x)),
      );
      scheduleRefresh();
    };
    const onDeleted = (id: string) =>
      setProducts((prev) => prev.filter((x) => x._id !== id));
    // 1-15B : suppression définitive, `{ _id }` seul.
    const onPurged = (data: { _id?: unknown }) => {
      if (typeof data?._id !== "string") return;
      const id = data._id;
      purged.current.add(id);
      setProducts((prev) => prev.filter((x) => x._id !== id));
    };
    socket.on("product:created", onCreated);
    socket.on("product:updated", onUpdated);
    socket.on("product:deleted", onDeleted);
    socket.on("product:purged", onPurged);
    return () => {
      socket.off("product:created", onCreated);
      socket.off("product:updated", onUpdated);
      socket.off("product:deleted", onDeleted);
      socket.off("product:purged", onPurged);
    };
  }, [socket, sectionId, scheduleRefresh]);

  const addProduct = useCallback(
    async (payload: {
      sectionId: string;
      name: string;
      purchasePrice: number;
      salePrice: number;
      initialQuantity: number;
      image: File;
    }) => {
      const p = await createProduct(payload);
      // 1-17B : photo comptée dans le quota → occupation relue si affichée.
      notifyStorageChanged();
      // socket also emits product:created; guard against double-insert
      setProducts((prev) =>
        prev.some((x) => x._id === p._id) ? prev : [p, ...prev],
      );
      return p;
    },
    [],
  );

  const editProduct = useCallback(
    async (id: string, payload: UpdateProductPayload) => {
      // 1-17B : `image` facultative (ajout ou remplacement de la photo) ;
      // `storageCleanup` = sort de l'ancienne photo, jamais stocké en liste.
      const { storageCleanup, ...p } = await updateProduct(id, payload);
      // socket also emits product:updated; upsert to stay consistent
      setProducts((prev) =>
        prev.some((x) => x._id === id)
          ? prev.map((x) => (x._id === id ? p : x))
          : [p, ...prev],
      );
      return { ...p, storageCleanup };
    },
    [],
  );

  const removeProduct = useCallback(async (id: string) => {
    await deleteProduct(id);
    setProducts((prev) => prev.filter((x) => x._id !== id));
  }, []);

  const reload = useCallback(() => load(), [load]);

  // 1-12H (correctif) : vente enregistrée, modifiée ou supprimée (par
  // n'importe quel membre) sur un produit affiché → stock restant et, si
  // autorisé, agrégats rechargés silencieusement via l'API.
  useSaleInvalidation(
    (productId) => products.some((p) => p._id === productId),
    scheduleRefresh,
  );

  return {
    products,
    isLoading,
    error,
    isOffline,
    reload,
    loadedAt,
    addProduct,
    editProduct,
    removeProduct,
  };
}
