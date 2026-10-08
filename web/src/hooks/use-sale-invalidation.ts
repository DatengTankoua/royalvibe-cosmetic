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

interface SaleInvalidationPayload {
  _id?: unknown;
  productId?: unknown;
}

/**
 * `matches(productId)` : le produit concerné est-il affiché ? `onInvalidate`
 * ne touche ni l'outbox ni l'état de synchronisation des ventes locales.
 *
 * 1-15A : appelé à CHAQUE événement concerné — le regroupement et la
 * sérialisation des relectures sont faits par l'appelant (`useLiveRefresh`),
 * qui conserve aussi une invalidation arrivée pendant un chargement (l'ancien
 * minuteur local de 400 ms ne le faisait pas). Hors ligne, le socket est
 * fermé et `useLiveRefresh` revérifie `navigator.onLine`.
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
    const handler = (payload: SaleInvalidationPayload) => {
      const productId =
        typeof payload?.productId === "string" ? payload.productId : null;
      if (!productId || !matchesRef.current(productId)) return;
      invalidateRef.current();
    };
    for (const event of SALE_INVALIDATION_EVENTS) socket.on(event, handler);
    return () => {
      for (const event of SALE_INVALIDATION_EVENTS) socket.off(event, handler);
    };
  }, [socket]);
}
