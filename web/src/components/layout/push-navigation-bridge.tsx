"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Notifications Web Push (1-16A) : au clic sur une notification, le service
// worker demande à une fenêtre déjà ouverte d'afficher la route interne
// visée. Navigation CLIENT uniquement (aucun rechargement) : ni vente, ni
// confirmation de paiement, ni échange de session, ni passe d'outbox. Les
// droits restent contrôlés par la page atteinte. Toute URL qui n'est pas un
// chemin interne `/app…` est ignorée.
const MESSAGE_TYPE = "stockmaster:push-navigate";

export function isInternalAppPath(url: unknown): url is string {
  return (
    typeof url === "string" &&
    /^\/app(\/[A-Za-z0-9/_-]*)?$/.test(url) &&
    !url.includes("//")
  );
}

export function PushNavigationBridge() {
  const router = useRouter();
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (data?.type !== MESSAGE_TYPE || !isInternalAppPath(data.url)) return;
      router.push(data.url);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () =>
      navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [router]);
  return null;
}
