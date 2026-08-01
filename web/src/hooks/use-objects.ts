"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchObjects, getApiErrorMessage, type ApiObject } from "@/lib/api";
import { useSocket } from "@/hooks/use-socket";

interface UseObjectsResult {
  objects: ApiObject[];
  isLoading: boolean;
  error: string | null;
  removeLocal: (id: string) => void;
}

export function useObjects(): UseObjectsResult {
  const [objects, setObjects] = useState<ApiObject[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const socket = useSocket();

  useEffect(() => {
    let cancelled = false;

    fetchObjects()
      .then((data) => {
        if (!cancelled) setObjects(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(getApiErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!socket) return;

    const handleCreated = (object: ApiObject) => {
      setObjects((current) =>
        current.some((o) => o._id === object._id)
          ? current
          : [object, ...current],
      );
    };
    const handleDeleted = (id: string) => {
      setObjects((current) => current.filter((o) => o._id !== id));
    };

    socket.on("object:created", handleCreated);
    socket.on("object:deleted", handleDeleted);

    return () => {
      socket.off("object:created", handleCreated);
      socket.off("object:deleted", handleDeleted);
    };
  }, [socket]);

  const removeLocal = useCallback((id: string) => {
    setObjects((current) => current.filter((o) => o._id !== id));
  }, []);

  return { objects, isLoading, error, removeLocal };
}
