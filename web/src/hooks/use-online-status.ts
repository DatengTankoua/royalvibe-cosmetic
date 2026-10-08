"use client";

import { useEffect, useState } from "react";

// Indicateur online/offline (1-11A) : lecture initiale synchrone de
// navigator.onLine (pas de flash "en ligne" pendant l'hydratation), puis
// écoute des événements online/offline avec nettoyage à l'unmount. Aucune
// mutation, file d'attente ou synchronisation automatique déclenchée ici.
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine,
  );

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return online;
}
