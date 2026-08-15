"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  getApiErrorMessage,
  type ApiProduct,
} from "@/lib/api";
import { useSocket } from "@/hooks/use-socket";

export function useProducts(sectionId?: string) {
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const socket = useSocket();

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await fetchProducts(sectionId);
      setProducts(data);
    } catch (err) {
      setError(getApiErrorMessage(err));
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

  return { products, isLoading, error, addProduct, editProduct, removeProduct };
}
