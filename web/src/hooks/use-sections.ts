"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchSections,
  createSection,
  deleteSection,
  updateSection,
  getApiErrorMessage,
  isNetworkError,
  type ApiSection,
} from "@/lib/api";
import { useSocket } from "@/contexts/socket-context";

export function useSections(parentId?: string) {
  const [sections, setSections] = useState<ApiSection[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 1-11B : vraie panne réseau (aucune réponse) uniquement — jamais une
  // réponse HTTP (401/403/404/5xx) — seule éligible au repli hors ligne.
  const [isOffline, setIsOffline] = useState(false);
  const socket = useSocket();

  const load = useCallback(async () => {
    try {
      const data = await fetchSections(parentId);
      setSections(data);
      setError(null);
      setIsOffline(false);
    } catch (err) {
      setError(getApiErrorMessage(err));
      setIsOffline(isNetworkError(err));
    } finally {
      setIsLoading(false);
    }
  }, [parentId]);

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

  const addSection = useCallback(
    async (name: string, description?: string, sectionParentId?: string) => {
      const s = await createSection({
        name,
        description,
        parentId: sectionParentId,
      });
      setSections((prev) => [s, ...prev]);
      return s;
    },
    [],
  );

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
    isOffline,
    reload: load,
    addSection,
    removeSection,
    renameSection,
  };
}
