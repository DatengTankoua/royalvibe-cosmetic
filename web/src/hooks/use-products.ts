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
} from "@/lib/api";
import { useSocket } from "@/contexts/socket-context";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import { hasPermission } from "@/lib/organization-permissions";
import { useSaleInvalidation } from "@/hooks/use-sale-invalidation";

// 1-12H : les diffusions Socket.IO ne portent que les champs standard. Un
// membre qui voit davantage recharge ses champs étendus via l'API autorisée
// (rechargement silencieux, sans état « Chargement… »).
const EVENT_REFRESH_DELAY_MS = 300;

export function useProducts(sectionId?: string) {
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 1-11B : vraie panne réseau (aucune réponse) uniquement — jamais une
  // réponse HTTP (401/403/404/5xx) — seule éligible au repli hors ligne.
  const [isOffline, setIsOffline] = useState(false);
  const socket = useSocket();
  const { authContext } = useOrganizationShell();
  const seesExtendedFields =
    hasPermission(authContext, "products.view_stock_details") ||
    hasPermission(authContext, "products.view_financials");
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 1-11C.3 : début de la dernière requête RÉUSSIE — une vente locale
  // confirmée après cet instant n'est pas encore reflétée dans `products`.
  const [loadedAt, setLoadedAt] = useState<number | undefined>(undefined);

  const load = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!options.silent) setIsLoading(true);
      const requestedAt = Date.now();
      try {
        const data = await fetchProducts(sectionId);
        setProducts(data);
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

  useEffect(() => {
    if (!socket) return;
    const scheduleRefresh = () => {
      if (!seesExtendedFields) return;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(
        () => void load({ silent: true }),
        EVENT_REFRESH_DELAY_MS,
      );
    };
    // Payload standard `{ product, status }` : jamais de champ restreint.
    const onCreated = (data: Parameters<typeof flattenProductEvent>[0]) => {
      const p = flattenProductEvent(data);
      if (sectionId && p.sectionId !== sectionId) return;
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
    socket.on("product:created", onCreated);
    socket.on("product:updated", onUpdated);
    socket.on("product:deleted", onDeleted);
    return () => {
      socket.off("product:created", onCreated);
      socket.off("product:updated", onUpdated);
      socket.off("product:deleted", onDeleted);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [socket, sectionId, seesExtendedFields, load]);

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
      // socket also emits product:created; guard against double-insert
      setProducts((prev) =>
        prev.some((x) => x._id === p._id) ? prev : [p, ...prev],
      );
      return p;
    },
    [],
  );

  const editProduct = useCallback(
    async (
      id: string,
      payload: {
        name?: string;
        purchasePrice?: number;
        salePrice?: number;
        additionalStock?: number;
      },
    ) => {
      const p = await updateProduct(id, payload);
      // socket also emits product:updated; upsert to stay consistent
      setProducts((prev) =>
        prev.some((x) => x._id === id)
          ? prev.map((x) => (x._id === id ? p : x))
          : [p, ...prev],
      );
      return p;
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
    () => void load({ silent: true }),
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
