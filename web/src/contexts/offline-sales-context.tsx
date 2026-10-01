"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { getToken } from "@/lib/auth";
import { hasPermission } from "@/lib/organization-permissions";
import { readSalesCapability } from "@/lib/offline-sales-capability";
import { canRecordSalesFromContext } from "@/lib/api";
import { readVerifiedIdentity } from "@/lib/offline-identity-db";
import {
  applyOperationAction,
  enqueueOfflineSale,
  expeditePartition,
  onOutboxChanged,
  readPartitionState,
  type EnqueueResult,
  type OperationAction,
  type OutboxOperation,
  type PartitionState,
} from "@/lib/offline-sales-outbox-db";
import {
  computeIndicativeStock,
  isUnfinalized,
} from "@/lib/offline-sales-policy";
import {
  onOfflineSalesSyncRequested,
  requestOfflineSalesSync,
} from "@/lib/offline-sales-sync";

// 1-11C.3 — État des ventes locales de la partition COURANTE, partagé par le
// shell /app : formulaire, stock indicatif, page « Ventes en attente »,
// badge. Identité = contexte serveur, sinon identité vérifiée localement
// (hors ligne). Aucune donnée d'une autre partition n'est jamais lue ici.

const SETTLE_TIMEOUT_MS = 10_000;

export interface SaleInput {
  productId: string;
  productName: string;
  unitPriceHint: number;
  quantity: number;
  salePrice: number;
  buyerName?: string;
  buyerContact?: string;
}

export type RecordSaleResult =
  | { kind: "synced"; operation: OutboxOperation }
  | { kind: "conflict"; operation: OutboxOperation }
  | { kind: "pending"; operation: OutboxOperation | null }
  | {
      kind: "refused";
      reason: Extract<EnqueueResult, { ok: false }>["reason"] | "capability";
    };

interface OfflineSalesValue {
  identity: { userId: string; organizationId: string } | null;
  online: boolean;
  // Réseau coupé, ou shell chargé sans contexte serveur (repli hors ligne).
  offline: boolean;
  // Saisie autorisée : en ligne = permission serveur ; hors ligne = snapshot
  // de capacité valide. Jamais une autorité : le serveur revalide tout.
  canRecordSales: boolean;
  // `unavailable` : aucune identité vérifiable pour ce token.
  status: "idle" | "loading" | "ready" | "error" | "unavailable";
  operations: OutboxOperation[];
  blocked: PartitionState["blocked"];
  unfinalizedCount: number;
  // Incrémenté quand une vente locale vient d'être confirmée par le serveur
  // (rafraîchir catalogue/ventes).
  syncedVersion: number;
  refresh: () => void;
  recordSale: (
    input: SaleInput,
    options?: { replaces?: string },
  ) => Promise<RecordSaleResult>;
  act: (clientOperationId: string, action: OperationAction) => Promise<boolean>;
  syncNow: () => Promise<void>;
}

const OfflineSalesContext = createContext<OfflineSalesValue | null>(null);

export function useOfflineSales(): OfflineSalesValue {
  const value = useContext(OfflineSalesContext);
  if (!value) {
    throw new Error("useOfflineSales doit être utilisé dans le shell /app.");
  }
  return value;
}

/**
 * Stock indicatif d'un produit : stock serveur/snapshot moins les ventes
 * locales qui réservent encore du stock (`reservesStock`), ≥ 0.
 * `serverLoadedAt` = début de la requête (ou écriture du snapshot) ayant
 * fourni `remainingQuantity` : une vente confirmée APRÈS reste réservée tant
 * que les données serveur ne l'incluent pas.
 */
export function useIndicativeStock(
  productId: string,
  remainingQuantity: number,
  serverLoadedAt?: number,
): { value: number; hasReservation: boolean } {
  const { operations } = useOfflineSales();
  return useMemo(() => {
    const { value, reserved } = computeIndicativeStock(
      remainingQuantity,
      operations,
      productId,
      serverLoadedAt,
    );
    return { value, hasReservation: reserved > 0 };
  }, [operations, productId, remainingQuantity, serverLoadedAt]);
}

export const OFFLINE_SALES_PANEL_ID = "offline-sales-panel";
export const OFFLINE_SALES_PANEL_OPEN_EVENT = "stockmaster:offline-sales-panel";

/**
 * Lien vers les ventes en attente : `/app/sales/pending` en ligne ; hors
 * ligne, `/app/catalog#offline-sales-panel` (seule route /app servie par le
 * service worker ; le fragment n'est jamais envoyé au serveur).
 */
export function usePendingSalesHref(): { href: string; offline: boolean } {
  const { offline } = useOfflineSales();
  return offline
    ? { href: `/app/catalog#${OFFLINE_SALES_PANEL_ID}`, offline }
    : { href: "/app/sales/pending", offline };
}

export function OfflineSalesProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { authContext, offlineIdentity } = useOrganizationShell();
  const online = useOnlineStatus();
  // Sans contexte serveur ni identité hors ligne (chargement, ou refus
  // 401/403 du contexte) : identité vérifiée localement pour CONSULTER et
  // EXPORTER ses propres ventes. Aucune saisie (capacité absente) et aucun
  // envoi (le moteur exige le contexte serveur).
  const [localIdentity, setLocalIdentity] = useState<
    { userId: string; organizationId: string } | null | undefined
  >(undefined);
  const needsLocalIdentity = !authContext && !offlineIdentity;
  useEffect(() => {
    if (!needsLocalIdentity) {
      setLocalIdentity(undefined);
      return;
    }
    let cancelled = false;
    void readVerifiedIdentity({ token: getToken() }).then((found) => {
      if (!cancelled) setLocalIdentity(found);
    });
    return () => {
      cancelled = true;
    };
  }, [needsLocalIdentity]);
  const identity = useMemo(
    () =>
      authContext
        ? {
            userId: authContext.userId,
            organizationId: authContext.organizationId,
          }
        : (offlineIdentity ?? localIdentity ?? null),
    [authContext, offlineIdentity, localIdentity],
  );
  const userId = identity?.userId;
  const organizationId = identity?.organizationId;

  const [state, setState] = useState<PartitionState | null>(null);
  const [status, setStatus] = useState<OfflineSalesValue["status"]>("idle");
  const [offlineCapability, setOfflineCapability] = useState(false);
  const [syncedVersion, setSyncedVersion] = useState(0);
  const syncedIds = useRef<Set<string> | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const refresh = useCallback(() => setReloadTick((v) => v + 1), []);

  // Lecture de la partition courante, relue à chaque changement d'outbox
  // (même onglet ou autre onglet) ou demande de passe, regroupée sur 150 ms.
  useEffect(() => {
    if (!userId || !organizationId) {
      setState(null);
      setStatus(localIdentity === null ? "unavailable" : "idle");
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      void readPartitionState({
        userId,
        organizationId,
        token: getToken(),
      }).then((next) => {
        if (cancelled) return;
        if (!next) {
          setStatus("error");
          return;
        }
        const synced = new Set(
          next.operations
            .filter((op) => op.status === "synced")
            .map((op) => op.clientOperationId),
        );
        const previous = syncedIds.current;
        if (previous && [...synced].some((id) => !previous.has(id))) {
          setSyncedVersion((v) => v + 1);
        }
        syncedIds.current = synced;
        setState(next);
        setStatus("ready");
      });
    };
    setStatus((s) => (s === "ready" ? s : "loading"));
    load();
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, 150);
    };
    const unsubscribe = onOutboxChanged(schedule);
    // Pointeur d'identité écrit par le shell → la lecture vérifiée devient
    // possible (évite un état « erreur » au premier rendu).
    const unsubscribeRequests = onOfflineSalesSyncRequested(schedule);
    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeRequests();
      if (timer) clearTimeout(timer);
    };
  }, [userId, organizationId, reloadTick, localIdentity]);

  // Capacité hors ligne : lue uniquement sans contexte serveur.
  useEffect(() => {
    if (authContext || !offlineIdentity) {
      setOfflineCapability(false);
      return;
    }
    let cancelled = false;
    void readSalesCapability({ ...offlineIdentity, token: getToken() }).then(
      (granted) => {
        if (!cancelled) setOfflineCapability(granted);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [authContext, offlineIdentity]);

  // 1-14C.2 : en ligne, la saisie exige l'accord SERVEUR explicite
  // (`access.canRecordSales`, faux dès que l'accès commercial est bloqué) —
  // une permission `sales.record` seule ne suffit plus.
  const canRecordSales = authContext
    ? canRecordSalesFromContext(authContext) &&
      hasPermission(authContext, "sales.record")
    : offlineCapability;

  const operations = useMemo(
    () => (state?.operations ?? []).filter((op) => op.status !== "abandoned"),
    [state],
  );
  const unfinalizedCount = operations.filter((op) =>
    isUnfinalized(op.status),
  ).length;

  const readOperation = useCallback(
    async (clientOperationId: string) => {
      if (!userId || !organizationId) return null;
      const next = await readPartitionState({
        userId,
        organizationId,
        token: getToken(),
      });
      return (
        next?.operations.find(
          (op) => op.clientOperationId === clientOperationId,
        ) ?? null
      );
    },
    [userId, organizationId],
  );

  // Attend la confirmation serveur (synced/conflict) au plus 10 s, sans
  // jamais la supposer : au-delà, la vente reste « en attente ».
  const waitForSettlement = useCallback(
    (clientOperationId: string) =>
      new Promise<OutboxOperation | null>((resolve) => {
        let done = false;
        let last: OutboxOperation | null = null;
        const finish = (op: OutboxOperation | null) => {
          if (done) return;
          done = true;
          clearTimeout(deadline);
          clearInterval(poll);
          unsubscribe();
          resolve(op);
        };
        const check = () => {
          void readOperation(clientOperationId).then((op) => {
            last = op;
            if (op && (op.status === "synced" || op.status === "conflict")) {
              finish(op);
            }
          });
        };
        const deadline = setTimeout(() => finish(last), SETTLE_TIMEOUT_MS);
        const poll = setInterval(check, 1000);
        const unsubscribe = onOutboxChanged(check);
        check();
      }),
    [readOperation],
  );

  const recordSale = useCallback<OfflineSalesValue["recordSale"]>(
    async (input, options) => {
      if (!userId || !organizationId || !canRecordSales) {
        return { kind: "refused", reason: "capability" };
      }
      const result = await enqueueOfflineSale({
        userId,
        organizationId,
        token: getToken(),
        payload: {
          productId: input.productId,
          quantity: input.quantity,
          salePrice: input.salePrice,
          ...(input.buyerName ? { buyerName: input.buyerName } : {}),
          ...(input.buyerContact ? { buyerContact: input.buyerContact } : {}),
        },
        display: {
          productName: input.productName,
          unitPriceHint: input.unitPriceHint,
        },
        ...(options?.replaces ? { replaces: options.replaces } : {}),
      });
      if (!result.ok) return { kind: "refused", reason: result.reason };
      if (typeof navigator === "undefined" || !navigator.onLine) {
        return {
          kind: "pending",
          operation: await readOperation(result.clientOperationId),
        };
      }
      requestOfflineSalesSync();
      const settled = await waitForSettlement(result.clientOperationId);
      if (settled?.status === "synced") {
        return { kind: "synced", operation: settled };
      }
      if (settled?.status === "conflict") {
        return { kind: "conflict", operation: settled };
      }
      return { kind: "pending", operation: settled };
    },
    [userId, organizationId, canRecordSales, readOperation, waitForSettlement],
  );

  const act = useCallback<OfflineSalesValue["act"]>(
    async (clientOperationId, action) => {
      if (!userId || !organizationId) return false;
      const ok = await applyOperationAction(
        { userId, organizationId, token: getToken() },
        clientOperationId,
        action,
      );
      if (ok && action !== "abandon") requestOfflineSalesSync();
      return ok;
    },
    [userId, organizationId],
  );

  const syncNow = useCallback(async () => {
    if (!userId || !organizationId) return;
    await expeditePartition({ userId, organizationId, token: getToken() });
    requestOfflineSalesSync();
  }, [userId, organizationId]);

  const offline = !online || (!authContext && offlineIdentity !== null);

  const value = useMemo<OfflineSalesValue>(
    () => ({
      identity,
      online,
      offline,
      canRecordSales,
      status,
      operations,
      blocked: state?.blocked ?? null,
      unfinalizedCount,
      syncedVersion,
      refresh,
      recordSale,
      act,
      syncNow,
    }),
    [
      identity,
      online,
      offline,
      canRecordSales,
      status,
      operations,
      state,
      unfinalizedCount,
      syncedVersion,
      refresh,
      recordSale,
      act,
      syncNow,
    ],
  );

  return (
    <OfflineSalesContext.Provider value={value}>
      {children}
    </OfflineSalesContext.Provider>
  );
}
