"use client";

import { WifiOffIcon } from "lucide-react";
import { useOnlineStatus } from "@/hooks/use-online-status";

// Indicateur accessible online/offline du shell /app (1-11A) : purement
// informatif, jamais de mutation/file d'attente/sync automatique — masqué
// tant que la connexion est disponible.
export function OnlineStatusIndicator() {
  const online = useOnlineStatus();
  if (online) return null;
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex shrink-0 items-center gap-1 rounded-md bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive"
    >
      <WifiOffIcon className="h-3.5 w-3.5" aria-hidden />
      <span className="hidden sm:inline">Hors connexion</span>
    </span>
  );
}
