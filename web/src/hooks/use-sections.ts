"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchSections,
  createSection,
  deleteSection,
  updateSection,
  getApiErrorMessage,
  type ApiSection,
} from "@/lib/api";
import { useSocket } from "@/hooks/use-socket";

export function useSections() {
  const [sections, setSections] = useState<ApiSection[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const socket = useSocket();

  const load = useCallback(async () => {
    try {
      const data = await fetchSections();
      setSections(data);
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!socket) return;
    const onCreated = (s: ApiSection) =>
      setSections((prev) =>
        prev.some((x) => x._id === s._id) ? prev : [s, ...prev],
      );
    const onDeleted = (id: string) =>
      setSections((prev) => prev.filter((s) => s._id !== id));
    socket.on("section:created", onCreated);
    socket.on("section:deleted", onDeleted);
    return () => {
      socket.off("section:created", onCreated);
      socket.off("section:deleted", onDeleted);
    };
  }, [socket]);

  const addSection = useCallback(async (name: string, description?: string) => {
    const s = await createSection({ name, description });
    setSections((prev) => [s, ...prev]);
    return s;
  }, []);

  const removeSection = useCallback(async (id: string) => {
    await deleteSection(id);
    setSections((prev) => prev.filter((s) => s._id !== id));
  }, []);

  const renameSection = useCallback(
    async (id: string, name: string, description?: string) => {
      const updated = await updateSection(id, { name, description });
      setSections((prev) => prev.map((s) => (s._id === id ? updated : s)));
      return updated;
    },
    [],
  );

  return {
    sections,
    isLoading,
    error,
    addSection,
    removeSection,
    renameSection,
  };
}
