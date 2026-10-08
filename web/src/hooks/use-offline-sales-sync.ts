"use client";

import { useEffect } from "react";
import { onOutboxChanged } from "@/lib/offline-sales-outbox-db";
import { OUTBOX_BACKOFF_MIN_MS } from "@/lib/offline-sales-policy";
import {
  abortCurrentOfflineSalesSync,
  isAuthTokenStorageKey,
  onOfflineSalesSyncRequested,
  resumeOfflineSalesSync,
  runOfflineSalesSync,
} from "@/lib/offline-sales-sync";

const SYNC_INTERVAL_MS = 60_000;

// 1-11C.2 — Déclencheurs du moteur de synchronisation des ventes, montés
// dans le shell /app uniquement. Partition = contexte SERVEUR résolu
// (`GET /auth/context`) ; `null` (hors ligne, refus, chargement) → inactif.
// Déclencheurs : montage, `online`, retour visible, ajout dans l'outbox
// (BroadcastChannel + même onglet), demande locale, échéance de backoff et
// intervalle 60 s tant que le shell est monté. Jamais de relance immédiate
// (≥ 2 s). Un changement du token dans un autre onglet (`storage`) annule la
// passe en cours. File vide → aucune requête réseau ni verrou.
export function useOfflineSalesSync(
  authContext: { userId: string; organizationId: string } | null,
): void {
  const userId = authContext?.userId;
  const organizationId = authContext?.organizationId;

  useEffect(() => {
    if (!userId || !organizationId) return;
    resumeOfflineSalesSync();
    const context = { userId, organizationId };
    let disposed = false;
    let running = false;
    let rerun = false;
    let dueTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleAt = (at: number) => {
      if (dueTimer) clearTimeout(dueTimer);
      dueTimer = setTimeout(
        () => {
          dueTimer = null;
          trigger();
        },
        Math.max(OUTBOX_BACKOFF_MIN_MS, at - Date.now()),
      );
    };

    const trigger = () => {
      if (disposed) return;
      if (running) {
        rerun = true;
        return;
      }
      running = true;
      void runOfflineSalesSync(context).then((result) => {
        running = false;
        if (disposed) return;
        if ("nextDueAt" in result && result.nextDueAt) {
          scheduleAt(result.nextDueAt);
        }
        if (rerun) {
          rerun = false;
          scheduleAt(Date.now() + OUTBOX_BACKOFF_MIN_MS);
        }
      });
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") trigger();
    };
    const onStorage = (event: StorageEvent) => {
      if (isAuthTokenStorageKey(event.key)) abortCurrentOfflineSalesSync();
    };

    trigger();
    window.addEventListener("online", trigger);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("storage", onStorage);
    const unsubscribeOutbox = onOutboxChanged((event) => {
      if (event === "enqueued") trigger();
    });
    const unsubscribeRequests = onOfflineSalesSyncRequested(trigger);
    const interval = setInterval(trigger, SYNC_INTERVAL_MS);

    return () => {
      disposed = true;
      window.removeEventListener("online", trigger);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("storage", onStorage);
      unsubscribeOutbox();
      unsubscribeRequests();
      clearInterval(interval);
      if (dueTimer) clearTimeout(dueTimer);
      abortCurrentOfflineSalesSync();
    };
  }, [userId, organizationId]);
}
