"use client";

import { useCallback, useEffect, useRef } from "react";
import { useSocket, useSocketConnectedAt } from "@/contexts/socket-context";
import { createRefreshCoordinator } from "@/lib/refresh-coordinator";

// 1-15A — relecture SILENCIEUSE d'un écran après un signal temps réel.
//
// - `request()` : demande regroupée et sérialisée (`createRefreshCoordinator`) ;
//   l'appelant l'abonne à ses événements Socket.IO (identifiants seuls).
// - Rattrapage : à chaque connexion du socket (reconnexion automatique,
//   retour du réseau, nouveau socket), si la dernière lecture RÉUSSIE a
//   commencé avant cette connexion, une relecture est demandée — les
//   événements émis pendant la coupure ne sont jamais rejoués.
// - Jamais hors ligne (`navigator.onLine` revérifié à l'exécution) : le
//   rattrapage aura lieu à la connexion suivante.
// - `lastLoadStartedAt` : début de la dernière requête réussie (même valeur
//   que `serverLoadedAt` 1-11C.3, jamais avancée par un événement).
export const LIVE_REFRESH_DELAY_MS = 400;

export function useLiveRefresh(
  refresh: () => Promise<unknown>,
  lastLoadStartedAt: number | undefined,
  delayMs: number = LIVE_REFRESH_DELAY_MS,
): () => void {
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });
  const coordinatorRef = useRef<ReturnType<
    typeof createRefreshCoordinator
  > | null>(null);

  useEffect(() => {
    const coordinator = createRefreshCoordinator(async () => {
      if (typeof navigator !== "undefined" && !navigator.onLine) return;
      await refreshRef.current();
    }, delayMs);
    coordinatorRef.current = coordinator;
    return () => {
      coordinator.dispose();
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null;
    };
  }, [delayMs]);

  const request = useCallback(() => coordinatorRef.current?.request(), []);

  const connectedAt = useSocketConnectedAt();
  const lastLoadRef = useRef(lastLoadStartedAt);
  useEffect(() => {
    lastLoadRef.current = lastLoadStartedAt;
  });
  useEffect(() => {
    if (connectedAt === null) return;
    const last = lastLoadRef.current;
    // Jamais chargé avec succès : le chargement initial (ou « Réessayer »)
    // s'en charge ; chargé APRÈS l'entrée dans la room : rien à rattraper.
    if (last === undefined || last >= connectedAt) return;
    request();
  }, [connectedAt, request]);

  return request;
}

/**
 * Abonnement à des événements Socket.IO utilisés comme SIGNAUX : le payload
 * (identifiants seuls) n'est jamais lu ; l'écran relit via l'API autorisée.
 */
export function useSocketSignals(
  events: readonly string[],
  onSignal: () => void,
): void {
  const socket = useSocket();
  const onSignalRef = useRef(onSignal);
  useEffect(() => {
    onSignalRef.current = onSignal;
  });
  const eventsKey = events.join("|");
  useEffect(() => {
    if (!socket) return;
    const names = eventsKey.split("|").filter(Boolean);
    const handler = () => onSignalRef.current();
    for (const name of names) socket.on(name, handler);
    return () => {
      for (const name of names) socket.off(name, handler);
    };
  }, [socket, eventsKey]);
}
