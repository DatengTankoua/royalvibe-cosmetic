"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchProducts,
  fetchProductsByIds,
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
import { useAuth } from "@/contexts/auth-context";
import { useSaleInvalidation } from "@/hooks/use-sale-invalidation";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import { useImageRenewal } from "@/hooks/use-image-renewal";
import { createCatalogFreshness, planRefresh } from "@/lib/catalog-refresh";
import { notifyStorageChanged } from "@/lib/storage-usage";

// 1-12H : les diffusions Socket.IO ne portent que les champs standard ; les
// champs étendus (selon les permissions) ne viennent que de l'API.
// 1-15A : toute diffusion produit ou vente concernant la liste déclenche une
// relecture SILENCIEUSE regroupée (`useLiveRefresh`), pour tous les membres :
// seule une lecture serveur réussie fait avancer `loadedAt` (1-11C.3), donc
// une fusion d'événement ne masque jamais une vente locale confirmée.
// 1-20D : une VENTE (créée, modifiée, annulée) ne relit que les produits
// concernés (`GET /products?ids=`, regroupés par `useLiveRefresh`, au plus
// `TARGETED_REFRESH_MAX_IDS`, voir `planRefresh`) ; relecture complète pour les signaux produit,
// le renouvellement des photos et le rattrapage après reconnexion. Ordre des
// réponses par produit (`createCatalogFreshness`) ; date de lecture serveur
// par produit (`serverLoadedAtFor`) pour le stock indicatif 1-11C.3.

export function useProducts(sectionId?: string) {
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 1-11B : vraie panne réseau (aucune réponse) uniquement — jamais une
  // réponse HTTP (401/403/404/5xx) — seule éligible au repli hors ligne.
  const [isOffline, setIsOffline] = useState(false);
  const socket = useSocket();
  // 1-15A / 1-20D : une réponse périmée (requête plus ancienne arrivée en
  // retard) n'écrase jamais une donnée plus récente, produit par produit.
  const freshness = useRef(createCatalogFreshness());
  // Liste courante (source des fusions ; `products` en est le reflet).
  const listRef = useRef<ApiProduct[]>([]);
  const update = useCallback((fn: (prev: ApiProduct[]) => ApiProduct[]) => {
    listRef.current = fn(listRef.current);
    setProducts(listRef.current);
  }, []);
  // 1-15B : produits supprimés définitivement — jamais réaffichés par une
  // réponse retenue (identifiants non réutilisés).
  const purged = useRef(new Set<string>());
  // 1-20D : produits à relire après une vente ; relecture complète demandée.
  const pendingIds = useRef(new Set<string>());
  const fullRequested = useRef(false);
  // 1-20D : début de la dernière lecture serveur réussie DE CHAQUE produit.
  const [productLoadedAt, setProductLoadedAt] = useState<
    Record<string, number>
  >({});
  // 1-20D : aucune réponse d'une session révolue n'est appliquée.
  const { sessionVersion } = useAuth();
  const sessionRef = useRef(sessionVersion);
  useEffect(() => {
    sessionRef.current = sessionVersion;
  });

  // 1-11C.3 : début de la dernière requête RÉUSSIE — une vente locale
  // confirmée après cet instant n'est pas encore reflétée dans `products`.
  const [loadedAt, setLoadedAt] = useState<number | undefined>(undefined);

  const load = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!options.silent) setIsLoading(true);
      const requestedAt = Date.now();
      const ticket = freshness.current.begin();
      const session = sessionRef.current;
      try {
        const data = await fetchProducts(sectionId);
        if (session !== sessionRef.current) return;
        const next = freshness.current.applyFull(
          ticket,
          listRef.current,
          data.filter((p) => !purged.current.has(p._id)),
        );
        if (!next) return;
        update(() => next);
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
    [sectionId, update],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /** 1-20D : relecture ciblée silencieuse des produits `ids`. */
  const loadTargeted = useCallback(
    async (ids: string[]) => {
      const requestedAt = Date.now();
      const ticket = freshness.current.begin();
      const session = sessionRef.current;
      try {
        const data = await fetchProductsByIds(ids, sectionId);
        if (session !== sessionRef.current) return;
        const { next, applied } = freshness.current.applyTargeted(
          ticket,
          listRef.current,
          ids,
          data.filter((p) => !purged.current.has(p._id)),
        );
        update(() => next);
        if (applied.length > 0) {
          setProductLoadedAt((prev) => {
            const copy = { ...prev };
            for (const id of applied) copy[id] = requestedAt;
            return copy;
          });
        }
      } catch {
        // Silencieux, comme une relecture complète en échec : produits
        // redemandés à la prochaine relecture (jamais de boucle d'essais).
        for (const id of ids) pendingIds.current.add(id);
      }
    },
    [sectionId, update],
  );

  /** Choix de la relecture au moment où elle part (après regroupement). */
  const refresh = useCallback(() => {
    const plan = planRefresh(pendingIds.current, fullRequested.current);
    pendingIds.current.clear();
    fullRequested.current = false;
    return plan.kind === "full"
      ? load({ silent: true })
      : loadTargeted(plan.ids);
  }, [load, loadTargeted]);

  const scheduleRefresh = useLiveRefresh(
    refresh,
    loadedAt,
    undefined,
    // Rattrapage après reconnexion : les événements manqués sont inconnus.
    () => {
      fullRequested.current = true;
    },
  );
  const requestFull = useCallback(() => {
    fullRequested.current = true;
    scheduleRefresh();
  }, [scheduleRefresh]);
  /** 1-20D : produits à relire (vente confirmée, signal de vente). */
  const refreshProducts = useCallback(
    (ids: readonly string[]) => {
      if (ids.length === 0) return;
      for (const id of ids) pendingIds.current.add(id);
      scheduleRefresh();
    },
    [scheduleRefresh],
  );
  // R2 privé : photo non chargeable (lien signé expiré) → relecture bornée.
  useImageRenewal(requestFull);

  useEffect(() => {
    if (!socket) return;
    // Payload standard `{ product, status }` : jamais de champ restreint.
    const onCreated = (data: Parameters<typeof flattenProductEvent>[0]) => {
      const p = flattenProductEvent(data);
      if (sectionId && p.sectionId !== sectionId) return;
      if (purged.current.has(p._id)) return;
      update((prev) =>
        prev.some((x) => x._id === p._id) ? prev : [p, ...prev],
      );
      requestFull();
    };
    const onUpdated = (data: Parameters<typeof flattenProductEvent>[0]) => {
      const common = flattenProductEvent(data);
      // Fusion des seuls champs standard : les champs étendus déjà chargés
      // sont conservés jusqu'au rechargement autorisé.
      update((prev) =>
        prev.map((x) => (x._id === common._id ? { ...x, ...common } : x)),
      );
      requestFull();
    };
    const onDeleted = (id: string) =>
      update((prev) => prev.filter((x) => x._id !== id));
    // 1-15B : suppression définitive, `{ _id }` seul.
    const onPurged = (data: { _id?: unknown }) => {
      if (typeof data?._id !== "string") return;
      const id = data._id;
      purged.current.add(id);
      update((prev) => prev.filter((x) => x._id !== id));
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
  }, [socket, sectionId, requestFull, update]);

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
      update((prev) =>
        prev.some((x) => x._id === p._id) ? prev : [p, ...prev],
      );
      return p;
    },
    [update],
  );

  const editProduct = useCallback(
    async (id: string, payload: UpdateProductPayload) => {
      // 1-17B : `image` facultative (ajout ou remplacement de la photo) ;
      // `storageCleanup` = sort de l'ancienne photo, jamais stocké en liste.
      const { storageCleanup, ...p } = await updateProduct(id, payload);
      // socket also emits product:updated; upsert to stay consistent
      update((prev) =>
        prev.some((x) => x._id === id)
          ? prev.map((x) => (x._id === id ? p : x))
          : [p, ...prev],
      );
      return { ...p, storageCleanup };
    },
    [update],
  );

  const removeProduct = useCallback(
    async (id: string) => {
      await deleteProduct(id);
      update((prev) => prev.filter((x) => x._id !== id));
    },
    [update],
  );

  const reload = useCallback(() => load(), [load]);

  // 1-12H (correctif) : vente enregistrée, modifiée ou supprimée (par
  // n'importe quel membre) sur un produit affiché → stock restant et, si
  // autorisé, agrégats rechargés silencieusement via l'API.
  // 1-20D : seul ce produit est relu (regroupé avec les autres ventes).
  useSaleInvalidation(
    (productId) => products.some((p) => p._id === productId),
    (productId) => refreshProducts([productId]),
  );

  /**
   * 1-20D : début de la dernière lecture serveur ayant fourni le stock de
   * `id` (liste complète ou relecture ciblée) — `serverLoadedAt` 1-11C.3.
   */
  const serverLoadedAtFor = useCallback(
    (id: string): number | undefined => {
      const own = productLoadedAt[id];
      if (own === undefined) return loadedAt;
      return loadedAt === undefined ? own : Math.max(own, loadedAt);
    },
    [productLoadedAt, loadedAt],
  );

  return {
    products,
    isLoading,
    error,
    isOffline,
    reload,
    refreshProducts,
    serverLoadedAtFor,
    loadedAt,
    addProduct,
    editProduct,
    removeProduct,
  };
}
