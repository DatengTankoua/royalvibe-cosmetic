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
import { useLiveRefresh, useSocketSignals } from "@/hooks/use-live-refresh";
import { createResponseOrder } from "@/lib/refresh-coordinator";

// 1-15A : mise à la corbeille (`product:deleted`) ou restauration
// (`product:created`) par un autre membre → corbeille relue silencieusement.
// La suppression définitive et les sections n'émettent aucun événement.
const TRASH_SIGNALS = ["product:deleted", "product:created"] as const;

// `enabled` (1-9D) : la corbeille est gardée par `trash.manage` côté backend
// — sans cette permission, ne JAMAIS déclencher `GET /trash` (403 inutile).
export function useTrash(enabled = true) {
  const [sections, setSections] = useState<ApiTrashedSection[]>([]);
  const [products, setProducts] = useState<ApiTrashedProduct[]>([]);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | undefined>(undefined);
  const order = useRef(createResponseOrder());

  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setIsLoading(true);
    const requestedAt = Date.now();
    const ticket = order.current.begin();
    try {
      const data = await fetchTrash();
      if (!order.current.accept(ticket)) return;
      setSections(data.sections);
      setProducts(data.products);
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
  useSocketSignals(TRASH_SIGNALS, enabled ? scheduleRefresh : () => {});

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

  const doPermanentDeleteProduct = useCallback(async (id: string) => {
    await permanentDeleteProduct(id);
    setProducts((prev) => prev.filter((p) => p._id !== id));
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

  const doBulkDeleteProducts = useCallback(async (ids: string[]) => {
    await Promise.all(ids.map(permanentDeleteProduct));
    setProducts((prev) => prev.filter((p) => !ids.includes(p._id)));
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
