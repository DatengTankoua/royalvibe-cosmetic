"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import { createResponseOrder } from "@/lib/refresh-coordinator";

// 1-15B — signaux de section émis par l'API : `{ _id, parentId }` seulement.
export const SECTION_SIGNALS = [
  "section:created",
  "section:updated",
  "section:deleted",
  "section:restored",
  "section:purged",
] as const;

export interface SectionSignal {
  _id: string;
  parentId: string | null;
}

/** Payload de signal de section valide, sinon `null` (jamais d'autre champ lu). */
export function readSectionSignal(payload: unknown): SectionSignal | null {
  if (!payload || typeof payload !== "object") return null;
  const { _id, parentId } = payload as { _id?: unknown; parentId?: unknown };
  if (typeof _id !== "string") return null;
  return { _id, parentId: typeof parentId === "string" ? parentId : null };
}

export function useSections(parentId?: string) {
  const [sections, setSections] = useState<ApiSection[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 1-11B : vraie panne réseau (aucune réponse) uniquement — jamais une
  // réponse HTTP (401/403/404/5xx) — seule éligible au repli hors ligne.
  const [isOffline, setIsOffline] = useState(false);
  const socket = useSocket();
  // 1-15B : début de la dernière lecture réussie (rattrapage après
  // reconnexion), ordre des réponses, et sections définitivement supprimées
  // (une réponse retenue ne les fait jamais réapparaître).
  const [loadedAt, setLoadedAt] = useState<number | undefined>(undefined);
  const order = useRef(createResponseOrder());
  const purged = useRef(new Set<string>());

  const load = useCallback(
    async (options: { silent?: boolean } = {}) => {
      const requestedAt = Date.now();
      const ticket = order.current.begin();
      try {
        const data = await fetchSections(parentId);
        if (!order.current.accept(ticket)) return;
        setSections(data.filter((s) => !purged.current.has(s._id)));
        setLoadedAt(requestedAt);
        setError(null);
        setIsOffline(false);
      } catch (err) {
        // Une relecture silencieuse en échec conserve la liste affichée.
        if (!options.silent) {
          setError(getApiErrorMessage(err));
          setIsOffline(isNetworkError(err));
        }
      } finally {
        setIsLoading(false);
      }
    },
    [parentId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const scheduleRefresh = useLiveRefresh(
    () => load({ silent: true }),
    loadedAt,
  );

  // 1-15B : création, renommage, corbeille, restauration ou suppression
  // définitive d'une section de CE niveau (ou d'une section affichée) par un
  // collègue → liste relue silencieusement via l'API.
  const sectionsRef = useRef(sections);
  useEffect(() => {
    sectionsRef.current = sections;
  });
  useEffect(() => {
    if (!socket) return;
    const level = parentId ?? null;
    const handlers = SECTION_SIGNALS.map((event) => {
      const handler = (payload: unknown) => {
        const signal = readSectionSignal(payload);
        if (!signal) return;
        if (event === "section:purged") {
          purged.current.add(signal._id);
          setSections((prev) => prev.filter((s) => s._id !== signal._id));
        }
        const shown = sectionsRef.current.some((s) => s._id === signal._id);
        if (signal.parentId === level || shown) scheduleRefresh();
      };
      socket.on(event, handler);
      return [event, handler] as const;
    });
    return () => {
      for (const [event, handler] of handlers) socket.off(event, handler);
    };
  }, [socket, parentId, scheduleRefresh]);

  const addSection = useCallback(
    async (name: string, description?: string, sectionParentId?: string) => {
      const s = await createSection({
        name,
        description,
        parentId: sectionParentId,
      });
      setSections((prev) =>
        prev.some((x) => x._id === s._id) ? prev : [s, ...prev],
      );
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

  const reload = useCallback(() => load(), [load]);

  return {
    sections,
    isLoading,
    error,
    isOffline,
    reload,
    addSection,
    removeSection,
    renameSection,
  };
}
