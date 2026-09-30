"use client";

import { useEffect, useRef } from "react";
import { useSocket } from "@/contexts/socket-context";

// 1-12H (correctif) — invalidation après les ventes (y compris celles des
// collègues) : `sale:created`, `sale:updated`, `sale:deleted` ne portent que
// `{ _id, productId }`, jamais de prix, vendeur, acheteur ni coordonnées.
// L'appelant recharge SILENCIEUSEMENT via l'API, qui applique ses propres
// permissions (stock restant pour tous, agrégats seulement si autorisé).
export const SALE_INVALIDATION_EVENTS = [
  "sale:created",
  "sale:updated",
  "sale:deleted",
] as const;

// Regroupe les événements rapprochés en UN seul rechargement.
export const SALE_INVALIDATION_DELAY_MS = 400;

interface SaleInvalidationPayload {
  _id?: unknown;
  productId?: unknown;
}

/**
 * `matches(productId)` : le produit concerné est-il affiché ? `onInvalidate`
 * n'est jamais appelé hors ligne (le socket y est déjà fermé, et
 * `navigator.onLine` est revérifié au déclenchement) et ne touche ni
 * l'outbox ni l'état de synchronisation des ventes locales.
 */
export function useSaleInvalidation(
  matches: (productId: string) => boolean,
  onInvalidate: () => void,
): void {
  const socket = useSocket();
  // Dernières fonctions en ref : pas de réabonnement à chaque rendu.
  const matchesRef = useRef(matches);
  const invalidateRef = useRef(onInvalidate);
  useEffect(() => {
    matchesRef.current = matches;
    invalidateRef.current = onInvalidate;
  });

  useEffect(() => {
    if (!socket) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handler = (payload: SaleInvalidationPayload) => {
      const productId =
        typeof payload?.productId === "string" ? payload.productId : null;
      if (!productId || !matchesRef.current(productId)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (typeof navigator !== "undefined" && !navigator.onLine) return;
        invalidateRef.current();
      }, SALE_INVALIDATION_DELAY_MS);
    };
    for (const event of SALE_INVALIDATION_EVENTS) socket.on(event, handler);
    return () => {
      for (const event of SALE_INVALIDATION_EVENTS) socket.off(event, handler);
      if (timer) clearTimeout(timer);
    };
  }, [socket]);
}
