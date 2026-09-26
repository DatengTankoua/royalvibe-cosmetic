"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  getApiErrorMessage,
  isNetworkError,
  type ApiProduct,
} from "@/lib/api";
import { useSocket } from "@/contexts/socket-context";

export function useProducts(sectionId?: string) {
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 1-11B : vraie panne réseau (aucune réponse) uniquement — jamais une
  // réponse HTTP (401/403/404/5xx) — seule éligible au repli hors ligne.
  const [isOffline, setIsOffline] = useState(false);
  const socket = useSocket();

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await fetchProducts(sectionId);
      setProducts(data);
      setError(null);
      setIsOffline(false);
    } catch (err) {
      setError(getApiErrorMessage(err));
      setIsOffline(isNetworkError(err));
    } finally {
      setIsLoading(false);
    }
  }, [sectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!socket) return;
    const onCreated = (p: ApiProduct) =>
      setProducts((prev) =>
        prev.some((x) => x._id === p._id) ? prev : [p, ...prev],
      );
    const onUpdated = (data: {
      product: ApiProduct;
      unitsSold: number;
      status: string;
      totalPurchaseCost: number;
      estimatedRevenue: number;
      estimatedProfit: number;
    }) => {
      const { product, ...metrics } = data;
      const flat = { ...product, ...metrics } as ApiProduct;
      setProducts((prev) => prev.map((x) => (x._id === flat._id ? flat : x)));
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
    };
  }, [socket]);

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

  return {
    products,
    isLoading,
    error,
    isOffline,
    addProduct,
    editProduct,
    removeProduct,
  };
}
