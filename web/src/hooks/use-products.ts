"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchProductsPage,
  fetchProductsByIds,
  createProduct,
  updateProduct,
  deleteProduct,
  flattenProductEvent,
  getApiErrorMessage,
  isNetworkError,
  PRODUCTS_PAGE_SIZE,
  type ApiProduct,
  type UpdateProductPayload,
} from "@/lib/api";
import { useSocket } from "@/contexts/socket-context";
import { useAuth } from "@/contexts/auth-context";
import { useSaleInvalidation } from "@/hooks/use-sale-invalidation";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import { useImageRenewal } from "@/hooks/use-image-renewal";
import { createCatalogFreshness, planRefresh } from "@/lib/catalog-refresh";
import { matchesProductSearch } from "@/lib/product-search";
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
//
// 1-20F : la liste est PAGINÉE (`GET /products?limit=…`, curseur) et la
// recherche est faite par le serveur sur tout le rayon. La « relecture
// complète » de 1-20D relit la SEULE page affichée (jamais les autres) avec
// ses totaux. Vue = session + rayon + recherche : un changement revient à la
// page 1 ; une réponse d'une autre vue, d'une autre page ou plus ancienne est
// ignorée. Un signal produit (création, modification, déplacement,
// corbeille, restauration, purge) relit la page affichée : un produit devenu
// éligible y apparaît s'il y a sa place, un produit sorti est remplacé par
// le suivant, les totaux suivent. Pages stables : un produit créé n'apparaît
// qu'en tête ; hors de la page 1, un avis propose d'y revenir. Une page
// devenue vide ramène à la précédente. API antérieure (`legacy`) : tableau
// complet, présenté comme complet.

export interface UseProductsOptions {
  /** Recherche (règle `matchesProductSearch`), appliquée par le serveur. */
  query?: string;
  /**
   * 1-20F : produits retirés (corbeille, purge) ou déplacés vers un autre
   * rayon (`movedTo`) — pour le catalogue hors ligne.
   */
  onRemoved?: (ids: string[], movedTo?: string) => void;
}

export function useProducts(
  sectionId?: string,
  options: UseProductsOptions = {},
) {
  const query = options.query ?? "";
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 1-11B : vraie panne réseau (aucune réponse) uniquement — jamais une
  // réponse HTTP (401/403/404/5xx) — seule éligible au repli hors ligne.
  const [isOffline, setIsOffline] = useState(false);
  const socket = useSocket();
  // 1-20F : totaux serveur (vue courante ; rayon sans recherche), page
  // suivante, API antérieure.
  const [total, setTotal] = useState<number | null>(null);
  const [scopeTotal, setScopeTotal] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [legacy, setLegacy] = useState(false);
  const [newerAvailable, setNewerAvailable] = useState(false);
  // 1-20F : curseur de chaque page visitée (page 0 : aucun curseur).
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  // 1-15A / 1-20D : une réponse périmée (requête plus ancienne arrivée en
  // retard) n'écrase jamais une donnée plus récente, produit par produit.
  // 1-20F : remis à zéro à chaque changement de vue ou de page.
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
  const onRemovedRef = useRef(options.onRemoved);
  useEffect(() => {
    onRemovedRef.current = options.onRemoved;
  });

  // 1-20F : vue demandée ; une réponse d'une autre vue ou page est ignorée.
  const viewKey = `${sessionVersion}\u0000${sectionId ?? ""}\u0000${query}`;
  const cursor = cursors[pageIndex] ?? null;
  const viewRef = useRef({ viewKey, pageIndex, cursor, query });
  useEffect(() => {
    viewRef.current = { viewKey, pageIndex, cursor, query };
  });
  const totalRef = useRef<number | null>(null);
  const sameView = useCallback((a: typeof viewRef.current) => {
    const now = viewRef.current;
    return (
      now.viewKey === a.viewKey &&
      now.pageIndex === a.pageIndex &&
      now.cursor === a.cursor
    );
  }, []);

  // 1-11C.3 : début de la dernière requête RÉUSSIE — une vente locale
  // confirmée après cet instant n'est pas encore reflétée dans `products`.
  const [loadedAt, setLoadedAt] = useState<number | undefined>(undefined);

  // Vue changée (session, rayon, recherche) : page 1, rien d'affiché d'une
  // autre vue.
  const [renderedView, setRenderedView] = useState(viewKey);
  if (renderedView !== viewKey) {
    setRenderedView(viewKey);
    setCursors([null]);
    setPageIndex(0);
    setNewerAvailable(false);
    setIsLoading(true);
  }
  useEffect(() => {
    viewRef.current = { viewKey, pageIndex: 0, cursor: null, query };
    totalRef.current = null;
    freshness.current = createCatalogFreshness();
    listRef.current = [];
    setProducts([]);
    setProductLoadedAt({});
    setLoadedAt(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey]);

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      const view = { ...viewRef.current };
      if (!opts.silent) setIsLoading(true);
      const requestedAt = Date.now();
      const ticket = freshness.current.begin();
      const session = sessionRef.current;
      try {
        const data = await fetchProductsPage({
          sectionId,
          cursor: view.cursor,
          query: view.query,
        });
        if (session !== sessionRef.current || !sameView(view)) return;
        // Page devenue vide (corbeille, déplacement) : page précédente.
        if (data.items.length === 0 && view.pageIndex > 0) {
          setIsLoading(true);
          setPageIndex(view.pageIndex - 1);
          return;
        }
        const next = freshness.current.applyFull(
          ticket,
          listRef.current,
          data.items.filter((p) => !purged.current.has(p._id)),
        );
        if (!next) {
          // Une page plus récente est déjà affichée.
          if (!opts.silent) setIsLoading(false);
          return;
        }
        update(() => next);
        if (view.pageIndex === 0) {
          setNewerAvailable(false);
        } else if (totalRef.current !== null && data.total > totalRef.current) {
          setNewerAvailable(true);
        }
        totalRef.current = data.total;
        setTotal(data.total);
        setScopeTotal(data.scopeTotal);
        setNextCursor(data.nextCursor);
        setLegacy(data.legacy);
        // Pages suivantes recalculées depuis la page relue : jamais un
        // produit de cette page répété sur la suivante.
        setCursors((prev) => {
          const kept = prev.slice(0, view.pageIndex + 1);
          if (data.nextCursor) kept.push(data.nextCursor);
          return kept;
        });
        setLoadedAt(requestedAt);
        setError(null);
        setIsOffline(false);
        if (!opts.silent) setIsLoading(false);
      } catch (err) {
        if (session !== sessionRef.current || !sameView(view)) return;
        // Un rechargement silencieux en échec conserve la liste affichée.
        if (!opts.silent) {
          setError(getApiErrorMessage(err));
          setIsOffline(isNetworkError(err));
          setIsLoading(false);
        }
      }
    },
    [sectionId, update, sameView],
  );

  useEffect(() => {
    void load();
  }, [load, viewKey, pageIndex]);

  // 1-20F : demande de relecture regroupée (définie plus bas).
  const scheduleRef = useRef<() => void>(() => undefined);

  /** 1-20D : relecture ciblée silencieuse des produits `ids`. */
  const loadTargeted = useCallback(
    async (ids: string[]) => {
      const view = { ...viewRef.current };
      const requestedAt = Date.now();
      const ticket = freshness.current.begin();
      const session = sessionRef.current;
      try {
        const data = await fetchProductsByIds(ids, sectionId);
        if (session !== sessionRef.current || !sameView(view)) return;
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
        // 1-20F : produit sorti de la vue → page complétée, totaux relus.
        const returned = new Set(data.map((p) => p._id));
        if (applied.some((id) => !returned.has(id))) {
          fullRequested.current = true;
          scheduleRef.current();
        }
      } catch {
        // Silencieux, comme une relecture complète en échec : produits
        // redemandés à la prochaine relecture (jamais de boucle d'essais).
        for (const id of ids) pendingIds.current.add(id);
      }
    },
    [sectionId, update, sameView],
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
    // Rattrapage après reconnexion : les événements manqués sont inconnus
    // (1-20F : page affichée seulement, jamais toutes les pages).
    () => {
      fullRequested.current = true;
    },
  );
  useEffect(() => {
    scheduleRef.current = scheduleRefresh;
  });
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

  /** 1-20F : produit à insérer en tête de la page affichée ? */
  const belongsAtHead = useCallback(
    (p: ApiProduct) =>
      viewRef.current.pageIndex === 0 &&
      (!sectionId || p.sectionId === sectionId) &&
      matchesProductSearch(p.name, viewRef.current.query),
    [sectionId],
  );
  const insertAtHead = useCallback(
    (p: ApiProduct) =>
      update((prev) =>
        prev.some((x) => x._id === p._id)
          ? prev
          : [p, ...prev].slice(0, PRODUCTS_PAGE_SIZE),
      ),
    [update],
  );

  useEffect(() => {
    if (!socket) return;
    // Payload standard `{ product, status }` : jamais de champ restreint.
    const onCreated = (data: Parameters<typeof flattenProductEvent>[0]) => {
      const p = flattenProductEvent(data);
      if (sectionId && p.sectionId !== sectionId) return;
      if (purged.current.has(p._id)) return;
      if (belongsAtHead(p)) insertAtHead(p);
      requestFull();
    };
    const onUpdated = (data: Parameters<typeof flattenProductEvent>[0]) => {
      const common = flattenProductEvent(data);
      // Fusion des seuls champs standard : les champs étendus déjà chargés
      // sont conservés jusqu'au rechargement autorisé.
      update((prev) =>
        prev.map((x) => (x._id === common._id ? { ...x, ...common } : x)),
      );
      if (sectionId && common.sectionId !== sectionId) {
        onRemovedRef.current?.([common._id], common.sectionId);
      }
      requestFull();
    };
    const onDeleted = (id: string) => {
      update((prev) => prev.filter((x) => x._id !== id));
      onRemovedRef.current?.([id]);
      requestFull();
    };
    // 1-15B : suppression définitive, `{ _id }` seul.
    const onPurged = (data: { _id?: unknown }) => {
      if (typeof data?._id !== "string") return;
      const id = data._id;
      purged.current.add(id);
      update((prev) => prev.filter((x) => x._id !== id));
      onRemovedRef.current?.([id]);
      requestFull();
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
  }, [socket, sectionId, requestFull, update, belongsAtHead, insertAtHead]);

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
      if (belongsAtHead(p)) insertAtHead(p);
      requestFull();
      return p;
    },
    [belongsAtHead, insertAtHead, requestFull],
  );

  const editProduct = useCallback(
    async (id: string, payload: UpdateProductPayload) => {
      // 1-17B : `image` facultative (ajout ou remplacement de la photo) ;
      // `storageCleanup` = sort de l'ancienne photo, jamais stocké en liste.
      const { storageCleanup, ...p } = await updateProduct(id, payload);
      // 1-20F : remplacé s'il est affiché (jamais ajouté à une page : sa
      // place est fixée par le tri) ; déplacé ailleurs ou ne correspondant
      // plus à la recherche → retiré ; page et totaux relus.
      const stays =
        (!sectionId || p.sectionId === sectionId) &&
        matchesProductSearch(p.name, viewRef.current.query);
      update((prev) =>
        stays
          ? prev.map((x) => (x._id === id ? p : x))
          : prev.filter((x) => x._id !== id),
      );
      if (sectionId && p.sectionId !== sectionId) {
        onRemovedRef.current?.([id], p.sectionId);
      }
      requestFull();
      return { ...p, storageCleanup };
    },
    [sectionId, update, requestFull],
  );

  const removeProduct = useCallback(
    async (id: string) => {
      await deleteProduct(id);
      update((prev) => prev.filter((x) => x._id !== id));
      onRemovedRef.current?.([id]);
      requestFull();
    },
    [update, requestFull],
  );

  const reload = useCallback(() => load(), [load]);

  // 1-12H (correctif) : vente enregistrée, modifiée ou supprimée (par
  // n'importe quel membre) sur un produit affiché → stock restant et, si
  // autorisé, agrégats rechargés silencieusement via l'API.
  // 1-20D : seul ce produit est relu (regroupé avec les autres ventes).
  // 1-20F : une vente ne change ni l'appartenance ni la place d'un produit
  // (tri par date de création, recherche par nom) : produits affichés seuls.
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

  /** 1-20F : navigation entre les pages de la vue courante. */
  const goToPage = useCallback(
    (index: number) => {
      if (index === pageIndex || index < 0 || index >= cursors.length) return;
      if (index === 0) setNewerAvailable(false);
      // Même rendu que le changement de page : jamais le numéro d'une page
      // avec les produits de la précédente.
      setIsLoading(true);
      freshness.current = createCatalogFreshness();
      listRef.current = [];
      setProducts([]);
      setPageIndex(index);
    },
    [pageIndex, cursors.length],
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
    // 1-20F
    total,
    scopeTotal,
    legacy,
    pageIndex,
    hasNext: !legacy && nextCursor !== null && cursors.length > pageIndex + 1,
    complete: legacy
      ? query.trim() === ""
      : pageIndex === 0 && nextCursor === null && query.trim() === "",
    newerAvailable,
    goToPage,
  };
}
