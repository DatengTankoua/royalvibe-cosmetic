"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchTrash,
  restoreSection,
  permanentDeleteSection,
  restoreProduct,
  permanentDeleteProduct,
  getApiErrorMessage,
  type ApiTrashedSection,
  type ApiTrashedProduct,
} from "@/lib/api";
import { notifyStorageChanged } from "@/lib/storage-usage";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import { useImageRenewal } from "@/hooks/use-image-renewal";
import { createResponseOrder } from "@/lib/refresh-coordinator";
import { useSocket } from "@/contexts/socket-context";

// 1-15A : mise à la corbeille (`product:deleted`) ou restauration
// (`product:created`) par un autre membre → corbeille relue silencieusement.
// 1-15B : sections (corbeille, restauration, suppression définitive) et
// suppression définitive d'un produit (`product:purged`, `{ _id }`).
const TRASH_SIGNALS = [
  "product:deleted",
  "product:created",
  "product:purged",
  "section:deleted",
  "section:restored",
  "section:purged",
] as const;

/** Identifiant porté par un signal (`id` brut ou `{ _id }`), sinon `null`. */
function signalId(payload: unknown): string | null {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    const id = (payload as { _id?: unknown })._id;
    if (typeof id === "string") return id;
  }
  return null;
}

// `enabled` (1-9D) : la corbeille est gardée par `trash.manage` côté backend
// — sans cette permission, ne JAMAIS déclencher `GET /trash` (403 inutile).
export function useTrash(enabled = true) {
  const [sections, setSections] = useState<ApiTrashedSection[]>([]);
  const [products, setProducts] = useState<ApiTrashedProduct[]>([]);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | undefined>(undefined);
  const order = useRef(createResponseOrder());
  // 1-15B : éléments supprimés définitivement — une réponse retenue avant la
  // suppression ne les fait jamais réapparaître (identifiants non réutilisés).
  const purgedIds = useRef(new Set<string>());

  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setIsLoading(true);
    const requestedAt = Date.now();
    const ticket = order.current.begin();
    try {
      const data = await fetchTrash();
      if (!order.current.accept(ticket)) return;
      setSections(data.sections.filter((x) => !purgedIds.current.has(x._id)));
      setProducts(data.products.filter((x) => !purgedIds.current.has(x._id)));
      setLoadedAt(requestedAt);
    } catch (err) {
      if (!options.silent) setError(getApiErrorMessage(err));
    } finally {
      if (!options.silent) setIsLoading(false);
    }
  }, []);

  const scheduleRefresh = useLiveRefresh(
    () => (enabled ? load({ silent: true }) : Promise.resolve()),
    enabled ? loadedAt : undefined,
  );
  // R2 privé : photo non chargeable (lien signé expiré) → relecture bornée.
  useImageRenewal(scheduleRefresh, enabled);
  const socket = useSocket();
  useEffect(() => {
    if (!socket || !enabled) return;
    const handlers = TRASH_SIGNALS.map((event) => {
      const handler = (payload: unknown) => {
        if (event === "product:purged" || event === "section:purged") {
          const id = signalId(payload);
          if (id) {
            purgedIds.current.add(id);
            setSections((prev) => prev.filter((x) => x._id !== id));
            setProducts((prev) => prev.filter((x) => x._id !== id));
          }
        }
        scheduleRefresh();
      };
      socket.on(event, handler);
      return [event, handler] as const;
    });
    return () => {
      for (const [event, handler] of handlers) socket.off(event, handler);
    };
  }, [socket, enabled, scheduleRefresh]);

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    void load();
  }, [enabled, load]);

  const doRestoreSection = useCallback(async (id: string) => {
    await restoreSection(id);
    setSections((prev) => prev.filter((s) => s._id !== id));
  }, []);

  const doPermanentDeleteSection = useCallback(async (id: string) => {
    await permanentDeleteSection(id);
    setSections((prev) => prev.filter((s) => s._id !== id));
  }, []);

  const doRestoreProduct = useCallback(async (id: string) => {
    await restoreProduct(id);
    setProducts((prev) => prev.filter((p) => p._id !== id));
  }, []);

  // Renvoie le sort du fichier (`failed` = photo non effacée du stockage).
  const doPermanentDeleteProduct = useCallback(async (id: string) => {
    const cleanup = await permanentDeleteProduct(id);
    setProducts((prev) => prev.filter((p) => p._id !== id));
    // 1-17B : occupation du stockage relue par les affichages montés.
    notifyStorageChanged();
    return cleanup;
  }, []);

  const doBulkRestoreSections = useCallback(async (ids: string[]) => {
    await Promise.all(ids.map(restoreSection));
    setSections((prev) => prev.filter((s) => !ids.includes(s._id)));
  }, []);

  const doBulkDeleteSections = useCallback(async (ids: string[]) => {
    await Promise.all(ids.map(permanentDeleteSection));
    setSections((prev) => prev.filter((s) => !ids.includes(s._id)));
  }, []);

  const doBulkRestoreProducts = useCallback(async (ids: string[]) => {
    await Promise.all(ids.map(restoreProduct));
    setProducts((prev) => prev.filter((p) => !ids.includes(p._id)));
  }, []);

  // Renvoie le nombre de photos non effacées du stockage.
  const doBulkDeleteProducts = useCallback(async (ids: string[]) => {
    const cleanups = await Promise.all(ids.map(permanentDeleteProduct));
    setProducts((prev) => prev.filter((p) => !ids.includes(p._id)));
    notifyStorageChanged();
    return cleanups.filter((c) => c === "failed").length;
  }, []);

  const reload = useCallback(() => load(), [load]);

  return {
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
  };
}
