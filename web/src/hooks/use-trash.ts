"use client";

import { useCallback, useEffect, useState } from "react";
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

export function useTrash() {
  const [sections, setSections] = useState<ApiTrashedSection[]>([]);
  const [products, setProducts] = useState<ApiTrashedProduct[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await fetchTrash();
      setSections(data.sections);
      setProducts(data.products);
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  return {
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
  };
}
