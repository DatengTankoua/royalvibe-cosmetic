"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useT } from "next-i18next/client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowLeftRightIcon,
  BarChart3Icon,
  Building2Icon,
  CircleHelpIcon,
  LayoutGridIcon,
  LogOutIcon,
  MoreHorizontalIcon,
  ShoppingBagIcon,
  StoreIcon,
  Trash2Icon,
} from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { SocketProvider } from "@/contexts/socket-context";
import { OrganizationShellContext } from "@/contexts/organization-shell-context";
import { OfflineSalesProvider } from "@/contexts/offline-sales-context";
import {
  PendingSalesHeaderLink,
  PendingSalesNavBadge,
} from "@/components/sales/pending-sales-nav";
import { LogoutPendingDialog } from "@/components/sales/logout-pending-dialog";
import { PendingSalesIfAny } from "@/components/sales/pending-sales-panel";
import { TenantLogo } from "@/components/brand/tenant-logo";
import { OnlineStatusIndicator } from "@/components/layout/online-status-indicator";
import { CurrencyConverter } from "@/components/currency/currency-converter";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { LanguageSwitcher } from "@/components/i18n/language-switcher";
import { useMessage } from "@/i18n/use-message";
import { EngagementPrompt } from "@/components/notifications/engagement-prompt";
import { LegalAcceptancePrompt } from "@/components/legal/legal-acceptance-prompt";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { hasPermission } from "@/lib/organization-permissions";
import {
  writeIdentityPointer,
  readVerifiedIdentity,
} from "@/lib/offline-identity-db";
import { getToken } from "@/lib/auth";
import {
  requestOfflineSalesSync,
  resumeOfflineSalesSync,
  runOfflineSalesSync,
  stopOfflineSalesSync,
} from "@/lib/offline-sales-sync";
import {
  clearSubscriptionBlock,
  deleteUserOperations,
  readUserUnfinalizedOperations,
  type OutboxOperation,
} from "@/lib/offline-sales-outbox-db";
import {
  forgetCommercialBlock,
  isCommerciallyBlocked,
  rememberCommercialBlock,
} from "@/lib/commercial-block";
import { CommercialBlockScreen } from "@/components/subscription/commercial-block-screen";
import {
  clearSalesCapability,
  writeSalesCapability,
} from "@/lib/offline-sales-capability";
import {
  clearTenantBrand,
  readTenantBrand,
  writeTenantBrand,
  type TenantBrandSnapshot,
} from "@/lib/offline-tenant-brand-db";
import { computeTenantAccent, tenantAccentStyle } from "@/lib/tenant-brand";
import { firstNameOf, fullNameOf } from "@/lib/display-names";
import { useOfflineSalesSync } from "@/hooks/use-offline-sales-sync";
import { useLiveRefresh, useSocketSignals } from "@/hooks/use-live-refresh";
import { createResponseOrder } from "@/lib/refresh-coordinator";
import { useOnlineStatus } from "@/hooks/use-online-status";
import {
  canRecordSalesFromContext,
  fetchActiveOrganizations,
  fetchAuthContext,
  fetchCurrentOrganization,
  getApiErrorCode,
  getApiErrorMessage,
  hasApplicationAccess,
  isNetworkError,
  setSubscriptionBlockedListener,
  SUBSCRIPTION_STATUS_UNAVAILABLE,
  type ApiAccessView,
  type ApiAuthContext,
  type ApiOrganizationCurrent,
  type SelectableOrganization,
} from "@/lib/api";

// 1-16G : libellés dans `common` (`shell.nav.*`).
type ShellNavKey =
  | "home"
  | "catalog"
  | "sales"
  | "analytics"
  | "trash"
  | "organization"
  | "help";

interface ShellNavItem {
  href: string;
  key: ShellNavKey;
  icon: typeof StoreIcon;
}

// Navigation des pages métier (1-9D) : masquage UX uniquement — filtrée par
// `authContext.effectivePermissions`, jamais `User.role`/`ApiUser.role`. La
// sécurité backend reste l'autorité finale sur chaque route.
function visibleNavItems(authContext: ApiAuthContext | null): ShellNavItem[] {
  const items: Array<ShellNavItem & { visible: boolean }> = [
    { href: "/app", key: "home", icon: StoreIcon, visible: true },
    {
      href: "/app/catalog",
      key: "catalog",
      icon: LayoutGridIcon,
      visible: true,
    },
    {
      href: "/app/sales",
      key: "sales",
      icon: ShoppingBagIcon,
      visible:
        hasPermission(authContext, "sales.view_own") ||
        hasPermission(authContext, "sales.view_all") ||
        hasPermission(authContext, "sales.record"),
    },
    {
      href: "/app/analytics",
      key: "analytics",
      icon: BarChart3Icon,
      visible: hasPermission(authContext, "analytics.read"),
    },
    {
      href: "/app/trash",
      key: "trash",
      icon: Trash2Icon,
      visible: hasPermission(authContext, "trash.manage"),
    },
    {
      href: "/app/organization",
      key: "organization",
      icon: Building2Icon,
      visible: true,
    },
    // 1-16C : guide public (hors shell, sans données). Hors ligne, il est
    // désactivé comme les autres pages par `ShellNavLink`.
    { href: "/guide", key: "help", icon: CircleHelpIcon, visible: true },
  ];
  return items.filter((i) => i.visible);
}

const MOBILE_PRIMARY_COUNT = 4;

// 1-15C — nom, couleur et logo modifiés par un collègue : `organization:updated`
// (payload vide) → relecture regroupée de `GET /organizations/current`,
// rattrapée à la reconnexion du socket. Monté DANS `SocketProvider`.
const ORGANIZATION_SIGNALS = ["organization:updated"] as const;

function OrganizationLiveSync({
  refresh,
  loadedAt,
}: {
  refresh: () => Promise<unknown>;
  loadedAt: number | undefined;
}) {
  const request = useLiveRefresh(refresh, loadedAt);
  useSocketSignals(ORGANIZATION_SIGNALS, request);
  return null;
}

// 1-15A — identité d'autorisation d'un contexte serveur : utilisateur,
// organisation, rôle, permissions effectives et accord de saisie. Quand elle
// change (droits modifiés en session ouverte, autre utilisateur ou autre
// organisation), les pages sont REMONTÉES : leurs données (champs projetés
// selon les anciens droits) et leurs requêtes en cours sont abandonnées, puis
// relues avec le nouveau contexte. Inchangée → aucun remontage.
function authorizationKey(ctx: ApiAuthContext): string {
  return [
    ctx.userId,
    ctx.organizationId,
    ctx.role,
    [...ctx.effectivePermissions].sort().join(","),
    ctx.access?.canRecordSales === true ? "sale" : "nosale",
  ].join("|");
}

// Correctif 1-11C.3 : seule route /app servie hors ligne par le service
// worker (document d'app shell précaché).
const OFFLINE_AVAILABLE_HREF = "/app/catalog";

/**
 * Lien de navigation du shell. En ligne : `Link` sans prefetch (aucune
 * requête RSC anticipée qui échouerait à la coupure du réseau). Hors ligne :
 * Catalogue = ancre HTML simple (document /app/catalog servi par le service
 * worker, jamais de fetch RSC) ; toute autre destination = élément non
 * interactif `aria-disabled` — jamais de tentative d'ouverture.
 */
function ShellNavLink({
  href,
  offline,
  className,
  disabledClassName,
  onClick,
  children,
}: {
  href: string;
  offline: boolean;
  className: string;
  disabledClassName: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const { t } = useT("common");
  if (!offline) {
    return (
      <Link
        href={href}
        prefetch={false}
        onClick={onClick}
        className={className}
      >
        {children}
      </Link>
    );
  }
  if (href === OFFLINE_AVAILABLE_HREF) {
    return (
      <a href={href} onClick={onClick} className={className}>
        {children}
      </a>
    );
  }
  return (
    <span
      role="link"
      aria-disabled="true"
      title={t("shell.offlineUnavailable")}
      className={`${className} ${disabledClassName}`}
    >
      {children}
      <span className="sr-only"> — {t("shell.offlineUnavailable")}</span>
    </span>
  );
}

// Shell authentifié partagé pour les pages /app (1-9B/1-9C/1-9D) : header
// desktop + navigation mobile fixe, identité visuelle du commerce (1-12A :
// logo/initiales, nom, couleur ; Stock Master en simple signature),
// navigation métier (catalogue/ventes/analyse/corbeille/organisation) et
// connexion Socket.IO unique partagée par les pages migrées. 1-12A : aucun
// changement d'organisation dans le shell — déconnexion puis connexion
// (sélection multi-organisation existante du login).
export default function AppShellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, isLoading, sessionVersion, logout, restrictedToken } =
    useAuth();
  const { t } = useT("common");
  const { t: ts } = useT("subscription");
  const router = useRouter();
  const pathname = usePathname();
  const [organization, setOrganization] =
    useState<ApiOrganizationCurrent | null>(null);
  const [organizations, setOrganizations] = useState<SelectableOrganization[]>(
    [],
  );
  // 1-9C : `null` tant que non chargé/en échec — l'absence masque
  // simplement la section « Organisation » (fail-closed), le backend
  // reste l'autorité finale sur chaque route.
  const [authContext, setAuthContext] = useState<ApiAuthContext | null>(null);
  // 1-11B : identité vérifiée localement, renseignée UNIQUEMENT sur une
  // vraie panne réseau du GET /auth/context (jamais sur 401/403 — voir
  // effet ci-dessous) — permet au catalogue de lire IndexedDB sans réseau.
  const [offlineIdentity, setOfflineIdentity] = useState<{
    userId: string;
    organizationId: string;
  } | null>(null);
  // 1-12A : nom + couleur du commerce relus hors ligne, uniquement après
  // validation de l'identité locale (correspondance exacte, TTL 72 h).
  const [offlineBrand, setOfflineBrand] = useState<TenantBrandSnapshot | null>(
    null,
  );
  const [loadingOrg, setLoadingOrg] = useState(true);
  // Indépendantes : l'échec de l'une ne doit jamais écraser le résultat
  // valide de l'autre (branding vs liste des organisations).
  const [brandingError, setBrandingError] = useMessage("common");
  const [listError, setListError] = useMessage("common");
  // Liste réellement reçue : « aucune organisation active » ne se déduit
  // jamais d'une liste non chargée (ex. hors ligne).
  const [listLoaded, setListLoaded] = useState(false);
  // Incrémenté pour forcer un rechargement du branding/liste/contexte sans
  // recharger toute la page (ex. après édition du branding, 1-9C).
  const [refreshTick, setRefreshTick] = useState(0);
  const refreshShell = () => setRefreshTick((v) => v + 1);
  const [converterOpen, setConverterOpen] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  // 1-14C.2 — accès COMMERCIAL bloqué (abonnement inactif) pour la session
  // applicative courante : interface métier, socket et envois arrêtés, sans
  // déconnexion ni suppression locale. `access` = vue serveur (null tant
  // qu'inconnue, ou blocage connu hors ligne).
  const [commercialBlock, setCommercialBlock] = useState<{
    access: ApiAccessView | null;
    identity: { userId: string; organizationId: string } | null;
  } | null>(null);
  // Lecture de l'état impossible (503) : ni expiration annoncée, ni accès.
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  // Contexte réglé (succès, refus ou repli) : les pages métier ne sont
  // montées qu'après — jamais sur une session dont l'accès est inconnu.
  const [contextReady, setContextReady] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyMessage, setVerifyMessage] = useMessage("subscription");
  const [managerReloadKey, setManagerReloadKey] = useState(0);
  // 1-15A : refus serveur du contexte (membership suspendue ou révoquée,
  // organisation suspendue, jeton refusé) — les pages métier sont retirées
  // (leurs données ne sont plus autorisées), seules les ventes locales et la
  // déconnexion restent proposées. Levé uniquement par un contexte valide.
  const [accessRefused, setAccessRefused] = useState(false);
  // 1-15A : session (utilisateur + version du jeton) à laquelle appartient
  // l'état du contexte ; les pages ne sont jamais montées avec le contexte
  // d'une session précédente (autre onglet, reprise d'une session limitée).
  const [contextSessionKey, setContextSessionKey] = useState<string | null>(
    null,
  );
  const [contentGeneration, setContentGeneration] = useState(0);
  const authorizationKeyRef = useRef<string | null>(null);
  // 1-15A : déconnexion décidée par le serveur (droits modifiés…) : si le
  // contexte relu reste valide, un nouveau socket est ouvert.
  const serverDisconnectedRef = useRef(false);
  const [socketRestartKey, setSocketRestartKey] = useState(0);
  const authContextRef = useRef<ApiAuthContext | null>(null);
  useEffect(() => {
    authContextRef.current = authContext;
  }, [authContext]);
  // 1-15C : ordre des réponses de `GET /organizations/current` (chargement
  // du shell et relectures temps réel) et début de la dernière lecture
  // appliquée (rattrapage après reconnexion).
  const organizationOrder = useRef(createResponseOrder());
  const [organizationLoadedAt, setOrganizationLoadedAt] = useState<
    number | undefined
  >(undefined);

  // 1-11C.2 : synchronisation des ventes hors ligne — partition issue du
  // contexte SERVEUR uniquement ; inactive sans contexte ou file vide.
  // 1-14C.2 : inactive aussi dès que l'accès commercial est bloqué.
  const sessionKey = user ? `${user._id}:${sessionVersion}` : null;
  const contextIsCurrent = contextSessionKey === sessionKey;
  useOfflineSalesSync(
    contextIsCurrent && !commercialBlock && hasApplicationAccess(authContext)
      ? authContext
      : null,
  );

  // 1-14C.2 : un appel du JWT applicatif COURANT refusé commercialement
  // (session ouverte puis expiration) bascule sur l'écran de blocage : le
  // refus est mémorisé pour cette identité, la capacité hors ligne retirée ;
  // le contexte est relu pour afficher l'état exact. Aucune déconnexion.
  useEffect(() => {
    setSubscriptionBlockedListener(() => {
      const ctx = authContextRef.current;
      const identity = ctx
        ? { userId: ctx.userId, organizationId: ctx.organizationId }
        : null;
      if (identity) rememberCommercialBlock(identity);
      void clearSalesCapability();
      setCommercialBlock((prev) => prev ?? { access: null, identity });
      setRefreshTick((v) => v + 1);
    });
    return () => setSubscriptionBlockedListener(null);
  }, []);

  // 1-11C.3 : shell ouvert hors ligne (contexte serveur absent) → au retour
  // du réseau, le contexte est rechargé ; il réactive la synchronisation.
  const needsContext = !authContext;
  useEffect(() => {
    if (!user || !needsContext) return;
    const onOnline = () => setRefreshTick((v) => v + 1);
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [user, needsContext]);

  // Hors ligne : réseau coupé, ou shell ouvert sans contexte serveur
  // (même définition que `useOfflineSales().offline`).
  const online = useOnlineStatus();
  const navOffline = !online || (!authContext && offlineIdentity !== null);

  const navItems = visibleNavItems(authContext);
  const mobileCompact = navItems.length > MOBILE_PRIMARY_COUNT;
  const mobilePrimary = mobileCompact
    ? navItems.slice(0, MOBILE_PRIMARY_COUNT)
    : navItems;
  const mobileOverflow = mobileCompact
    ? navItems.slice(MOBILE_PRIMARY_COUNT)
    : [];

  useEffect(() => {
    // 1-14C.2 : une session LIMITÉE n'entre jamais dans le shell métier.
    if (!isLoading && !user) {
      router.push(restrictedToken ? "/access" : "/auth/login");
    }
  }, [user, isLoading, router, restrictedToken]);

  const effectSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const currentSession = `${user._id}:${sessionVersion}`;
    // 1-15A : nouvelle session → aucun état de l'ancienne n'est conservé.
    if (effectSessionRef.current !== currentSession) {
      effectSessionRef.current = currentSession;
      setAuthContext(null);
      setOrganization(null);
      setOfflineIdentity(null);
      setCommercialBlock(null);
      setAccessRefused(false);
      setContextReady(false);
      setListLoaded(false);
      setOrganizations([]);
    }
    setLoadingOrg(true);
    setBrandingError(null);
    setListError(null);
    setStatusUnavailable(false);
    // Correctif 1-11C.3 : navigateur déjà hors ligne → aucune requête ne
    // peut atteindre le serveur ; l'identité vérifiée localement est lue
    // tout de suite (catalogue hors ligne sans attendre l'échec réseau du
    // contexte). Ignorée dès que le contexte a répondu : un succès la
    // remplace, un refus 401/403 la remet à `null` (fail-closed).
    let contextSettled = false;
    // 1-12A : l'identité visuelle hors ligne n'est lue QU'APRÈS validation
    // de l'identité locale courante, pour ce user/organisation exacts.
    const readOfflineFallback = async () => {
      const identity = await readVerifiedIdentity({ token: getToken() });
      const brand = identity ? await readTenantBrand(identity) : null;
      return { identity, brand };
    };
    // 1-14C.2 : un refus commercial CONNU pour cette identité n'est jamais
    // contourné par le repli hors ligne (cache, rechargement, coupure).
    const applyOfflineFallback = ({
      identity,
      brand,
    }: Awaited<ReturnType<typeof readOfflineFallback>>) => {
      setOfflineBrand(brand);
      if (identity && isCommerciallyBlocked(identity)) {
        setOfflineIdentity(null);
        setCommercialBlock({ access: null, identity });
      } else {
        setOfflineIdentity(identity);
      }
      setContextSessionKey(currentSession);
      setContextReady(true);
    };
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      void readOfflineFallback().then((fallback) => {
        if (cancelled || contextSettled) return;
        applyOfflineFallback(fallback);
      });
    }

    void (async () => {
      let ctx: ApiAuthContext;
      try {
        ctx = await fetchAuthContext();
      } catch (reason) {
        contextSettled = true;
        if (cancelled) return;
        setAuthContext(null);
        setOrganization(null);
        // Distinction stricte : une vraie panne réseau peut retomber sur
        // l'identité vérifiée localement ; une réponse HTTP (401/403/autre)
        // est une révocation/refus serveur — JAMAIS transformée en mode
        // hors ligne, fail-closed.
        if (isNetworkError(reason)) {
          applyOfflineFallback(await readOfflineFallback());
        } else if (
          getApiErrorCode(reason) === SUBSCRIPTION_STATUS_UNAVAILABLE
        ) {
          // 1-14C.2 : état temporairement illisible — aucun accès accordé,
          // aucune expiration annoncée ; rien n'est effacé.
          setOfflineIdentity(null);
          setStatusUnavailable(true);
          setContextSessionKey(currentSession);
          setContextReady(true);
        } else {
          setOfflineIdentity(null);
          setOfflineBrand(null);
          // Refus serveur : plus aucune saisie hors ligne sur cet appareil,
          // ni identité visuelle du commerce.
          void clearSalesCapability();
          void clearTenantBrand();
          // 1-15A : pages métier retirées (données devenues interdites).
          setAccessRefused(true);
          setContextSessionKey(currentSession);
          setContextReady(true);
        }
        setLoadingOrg(false);
        return;
      }
      contextSettled = true;
      if (cancelled) return;
      const identity = {
        userId: ctx.userId,
        organizationId: ctx.organizationId,
      };
      const token = getToken();
      setAuthContext(ctx);
      setOfflineIdentity(null);
      setAccessRefused(false);
      setContextSessionKey(currentSession);
      // 1-15A : droits, rôle, organisation ou utilisateur changés → pages
      // remontées (données et requêtes de l'ancien contexte abandonnées).
      const nextKey = authorizationKey(ctx);
      if (
        authorizationKeyRef.current !== null &&
        authorizationKeyRef.current !== nextKey
      ) {
        setContentGeneration((v) => v + 1);
      }
      authorizationKeyRef.current = nextKey;

      // 1-14C.2 — accès commercial BLOQUÉ : aucun appel métier (branding
      // compris), capacité hors ligne retirée, refus mémorisé. Le pointeur
      // d'identité (contexte serveur) permet la consultation locale.
      if (!hasApplicationAccess(ctx)) {
        rememberCommercialBlock(identity);
        void clearSalesCapability();
        setCommercialBlock({ access: ctx.access ?? null, identity });
        setOrganization(null);
        if (token) void writeIdentityPointer({ ...identity, token });
        try {
          const list = await fetchActiveOrganizations();
          if (!cancelled) {
            setOrganizations(list);
            setListLoaded(true);
          }
        } catch {
          // nom du commerce simplement absent
        }
        if (!cancelled) {
          setContextReady(true);
          setLoadingOrg(false);
        }
        return;
      }
      forgetCommercialBlock(identity);
      setCommercialBlock(null);
      setContextReady(true);
      // 1-15A : socket fermé par le serveur mais contexte toujours valide
      // (ex. permissions modifiées) → un seul nouveau socket.
      if (serverDisconnectedRef.current) {
        serverDisconnectedRef.current = false;
        setSocketRestartKey((v) => v + 1);
      }

      // `allSettled` : une organisation courante suspendue (403) ne doit
      // jamais empêcher l'exploitation d'une liste d'organisations valide,
      // et vice-versa.
      const organizationRequestedAt = Date.now();
      const organizationTicket = organizationOrder.current.begin();
      const [currentResult, listResult] = await Promise.allSettled([
        fetchCurrentOrganization(),
        fetchActiveOrganizations(),
      ]);
      if (cancelled) return;
      if (currentResult.status === "fulfilled") {
        if (organizationOrder.current.accept(organizationTicket)) {
          setOrganization(currentResult.value);
          setOrganizationLoadedAt(organizationRequestedAt);
        }
      } else {
        setOrganization(null);
        // 1-11C.3a : une panne réseau n'est pas une erreur à afficher (le
        // message hors ligne unique du shell suffit) ; seul un refus serveur
        // est signalé.
        if (!isNetworkError(currentResult.reason)) {
          setBrandingError((tr) => tr("shell.organizationUnavailable"));
        }
      }
      if (listResult.status === "fulfilled") {
        setOrganizations(listResult.value);
        setListLoaded(true);
      } else {
        setListLoaded(false);
        if (!isNetworkError(listResult.reason)) {
          setListError(getApiErrorMessage(listResult.reason));
        }
      }
      // 1-12A : snapshot visuel écrit seulement si les DEUX réponses ont
      // réussi et désignent la même organisation (champs recopiés un à un,
      // jamais la réponse brute).
      if (
        currentResult.status === "fulfilled" &&
        currentResult.value._id === ctx.organizationId
      ) {
        void writeTenantBrand({
          userId: ctx.userId,
          organizationId: ctx.organizationId,
          organizationName: currentResult.value.name,
          brandColor: currentResult.value.brandColor,
        });
      }
      if (token) {
        const canRecordSales = canRecordSalesFromContext(ctx);
        // 1-11C.2 : pointeur écrit → le moteur peut vérifier l'identité.
        // 1-14C.2 : puis levée EXPLICITE d'un blocage commercial de l'outbox
        // (JWT applicatif, accès et saisie autorisés par le serveur, même
        // identité) — jamais d'un blocage de permissions ou de corruption.
        void writeIdentityPointer({ ...identity, token }).then(
          async (written) => {
            if (!written || cancelled) return;
            if (canRecordSales) {
              await clearSubscriptionBlock({ ...identity, token });
            }
            if (!cancelled) requestOfflineSalesSync();
          },
        );
        // 1-11C.3 : capacité minimale de saisie hors ligne (booléen seul),
        // liée à l'identité et au token courants, TTL 72 h. 1-14C.2 : selon
        // l'accord serveur `access.canRecordSales`.
        void writeSalesCapability({ ...identity, token, canRecordSales });
      }
      setLoadingOrg(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, sessionVersion, refreshTick, setBrandingError, setListError]);

  // 1-14C.2 — « Vérifier mon abonnement » (session applicative bloquée) :
  // relecture du contexte serveur, AUCUN changement de token. L'accès ne
  // reprend que si le serveur l'indique pour cette session.
  const verifyCommercialAccess = useCallback(async () => {
    setVerifying(true);
    setVerifyMessage(null);
    try {
      const ctx = await fetchAuthContext();
      setManagerReloadKey((v) => v + 1);
      if (hasApplicationAccess(ctx)) {
        forgetCommercialBlock({
          userId: ctx.userId,
          organizationId: ctx.organizationId,
        });
        setCommercialBlock(null);
        setRefreshTick((v) => v + 1);
        return;
      }
      setCommercialBlock({
        access: ctx.access ?? null,
        identity: { userId: ctx.userId, organizationId: ctx.organizationId },
      });
      setVerifyMessage((tr) => tr("verify.stillInactive"));
    } catch (err) {
      setVerifyMessage((tr) =>
        isNetworkError(err)
          ? tr("verify.offline")
          : tr("manager.checkUnavailable"),
      );
    } finally {
      setVerifying(false);
    }
  }, [setVerifyMessage]);

  // 1-15C : relecture SEULE de l'organisation courante (nom, couleur, logo)
  // pour la session et l'organisation en cours : aucune relecture du
  // contexte, aucune passe de l'outbox, aucun nouveau socket. Une réponse
  // d'une autre session, d'une autre organisation ou plus ancienne
  // qu'une réponse déjà appliquée est ignorée.
  const refreshOrganization = useCallback(async () => {
    const session = effectSessionRef.current;
    const expectedOrganization = authContextRef.current?.organizationId;
    if (!session || !expectedOrganization) return;
    const requestedAt = Date.now();
    const ticket = organizationOrder.current.begin();
    let current: ApiOrganizationCurrent;
    try {
      current = await fetchCurrentOrganization();
    } catch {
      return; // l'organisation affichée est conservée
    }
    if (effectSessionRef.current !== session) return;
    if (current._id !== expectedOrganization) return;
    if (authContextRef.current?.organizationId !== expectedOrganization) return;
    if (!organizationOrder.current.accept(ticket)) return;
    setOrganization(current);
    setOrganizationLoadedAt(requestedAt);
    const ctx = authContextRef.current;
    if (ctx) {
      void writeTenantBrand({
        userId: ctx.userId,
        organizationId: ctx.organizationId,
        organizationName: current.name,
        brandColor: current.brandColor,
      });
    }
  }, []);
  const triggerOrganizationRefresh = useCallback(() => {
    void refreshOrganization();
  }, [refreshOrganization]);

  const noActiveOrganization =
    !loadingOrg && listLoaded && organizations.length === 0;

  // 1-11C.3 : déconnexion volontaire. Worker arrêté, puis recensement des
  // ventes locales non finalisées de TOUTES les organisations de
  // l'utilisateur : aucune → logout normal ; sinon choix explicite
  // (synchroniser, conserver, supprimer). Jamais de suppression
  // par défaut ; lecture impossible → logout sans suppression.
  const [logoutPending, setLogoutPending] = useState<OutboxOperation[] | null>(
    null,
  );
  const logoutRef = useRef(false);

  const finishLogout = async () => {
    setLogoutPending(null);
    await logout();
    router.push("/auth/login");
  };

  const cancelLogout = () => {
    setLogoutPending(null);
    resumeOfflineSalesSync();
    requestOfflineSalesSync();
  };

  const handleLogout = () => {
    if (logoutRef.current || !user) return;
    logoutRef.current = true;
    setPlusOpen(false);
    void (async () => {
      try {
        await stopOfflineSalesSync(3000);
        const pending = await readUserUnfinalizedOperations(user._id);
        if (pending === null) {
          await finishLogout();
          toast.warning(t("shell.logout.unverified"));
          return;
        }
        if (pending.length === 0) {
          await finishLogout();
          return;
        }
        setLogoutPending(pending);
      } finally {
        logoutRef.current = false;
      }
    })();
  };

  const syncBeforeLogout = async () => {
    if (!user) return;
    resumeOfflineSalesSync();
    if (authContext) {
      await Promise.race([
        runOfflineSalesSync(authContext),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
    }
    await stopOfflineSalesSync(3000);
    const remaining = await readUserUnfinalizedOperations(user._id);
    if (remaining !== null && remaining.length === 0) {
      await finishLogout();
      toast.success(t("shell.logout.synced"));
      return;
    }
    if (remaining !== null) setLogoutPending(remaining);
    toast.info(t("shell.logout.stillPending"));
  };

  if (isLoading || !user) return null;

  const isActive = (href: string) =>
    href === "/app" ? pathname === "/app" : pathname.startsWith(href);

  // 1-12A : identité visuelle du commerce — réponse serveur en priorité,
  // sinon snapshot hors ligne validé (jamais de logo hors ligne : initiales).
  const organizationName =
    organization?.name ?? offlineBrand?.organizationName ?? null;
  const organizationTitle = fullNameOf(organizationName);
  const brandLoading = loadingOrg && organizationName === null;
  const accentStyle = tenantAccentStyle(
    computeTenantAccent(organization?.brandColor ?? offlineBrand?.brandColor),
  );
  const userFullName = fullNameOf(user.name);

  // 1-14C.2 — accès commercial bloqué : écran unique, sans socket, sans
  // moteur de synchronisation ni pages métier. Consultation locale et
  // déconnexion (avec choix explicite si des ventes restent) conservés.
  if (commercialBlock) {
    const blockedIdentity =
      commercialBlock.identity ??
      (authContext
        ? {
            userId: authContext.userId,
            organizationId: authContext.organizationId,
          }
        : null);
    const blockedName =
      organizations.find(
        (o) => o.organizationId === blockedIdentity?.organizationId,
      )?.name ??
      offlineBrand?.organizationName ??
      null;
    return (
      <div
        data-tenant-shell=""
        style={accentStyle}
        className="flex min-h-full flex-1 flex-col"
      >
        <header className="sticky top-0 z-40 border-b border-(--tenant-accent-border) bg-background">
          <div className="mx-auto flex h-16 max-w-4xl items-center gap-3 px-4 sm:px-6">
            <div
              className="flex min-w-0 flex-1 items-center gap-2.5"
              title={fullNameOf(blockedName) ?? undefined}
            >
              <TenantLogo name={blockedName} logoUrl={null} />
              <span className="truncate text-sm font-semibold sm:text-base">
                {blockedName ?? t("shell.myShop")}
              </span>
            </div>
            <OnlineStatusIndicator />
            {/* 1-16G : langue puis thème. */}
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </header>
        <main className="flex flex-1 flex-col pb-10">
          <CommercialBlockScreen
            access={commercialBlock.access}
            isOwner={
              commercialBlock.access?.canRenew === true ||
              (commercialBlock.access === null && authContext?.role === "owner")
            }
            offline={!online}
            identity={blockedIdentity}
            pendingToken={getToken()}
            onVerify={() => void verifyCommercialAccess()}
            verifying={verifying}
            verifyMessage={verifyMessage}
            onLogout={handleLogout}
            managerReloadKey={managerReloadKey}
          />
        </main>
        {logoutPending && (
          <LogoutPendingDialog
            operations={logoutPending}
            online={typeof navigator === "undefined" || navigator.onLine}
            canSync={false}
            onCancel={cancelLogout}
            onSyncNow={syncBeforeLogout}
            onKeepAndLogout={finishLogout}
            onDeleteAndLogout={async () => {
              const ok = await deleteUserOperations(user._id);
              if (ok) await finishLogout();
              return ok;
            }}
          />
        )}
      </div>
    );
  }

  return (
    <SocketProvider
      restartKey={socketRestartKey}
      onServerDisconnect={() => {
        serverDisconnectedRef.current = true;
        setRefreshTick((v) => v + 1);
      }}
    >
      <OrganizationShellContext.Provider
        value={{
          organization,
          authContext: contextIsCurrent ? authContext : null,
          refreshShell,
          refreshOrganization: triggerOrganizationRefresh,
          offlineIdentity: contextIsCurrent ? offlineIdentity : null,
        }}
      >
        {contextIsCurrent && authContext && (
          <OrganizationLiveSync
            refresh={refreshOrganization}
            loadedAt={organizationLoadedAt}
          />
        )}
        <OfflineSalesProvider>
          {/* 1-12A : jetons --tenant-* posés sur la racine du shell
          uniquement (jamais :root) — pages publiques/auth/offline intactes. */}
          <div
            data-tenant-shell=""
            style={accentStyle}
            className="flex min-h-full flex-1 flex-col"
          >
            <header className="sticky top-0 z-40 border-b border-(--tenant-accent-border) bg-background">
              <div className="mx-auto flex h-16 max-w-4xl items-center gap-3 px-4 sm:px-6">
                {/* Identité du commerce : logo (ou initiales), nom tronqué
                (complet dans `title`), signature Stock Master discrète
                masquée sous `sm`. */}
                <div
                  className="flex min-w-0 flex-1 items-center gap-2.5"
                  title={organizationTitle ?? undefined}
                  data-testid="tenant-identity"
                >
                  <TenantLogo
                    name={organizationName}
                    logoUrl={organization?.logoUrl}
                  />
                  <div className="flex min-w-0 flex-col leading-tight">
                    {brandLoading ? (
                      <span
                        className="h-4 w-28 max-w-full animate-pulse rounded bg-muted"
                        aria-label={t("shell.loading")}
                      />
                    ) : (
                      <span
                        className="truncate text-sm font-semibold sm:text-base"
                        data-testid="tenant-name"
                      >
                        {organizationName ?? t("shell.myShop")}
                      </span>
                    )}
                    <span
                      className="hidden text-[11px] text-muted-foreground sm:block"
                      data-testid="stockmaster-signature"
                    >
                      by Stock Master
                    </span>
                  </div>
                </div>

                <div className="ml-auto flex shrink-0 items-center gap-2">
                  <OnlineStatusIndicator />
                  <PendingSalesHeaderLink />
                  <button
                    type="button"
                    onClick={() => setConverterOpen(true)}
                    title={t("shell.converter")}
                    aria-label={t("shell.converter")}
                    className="hidden rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground sm:inline-flex"
                  >
                    <ArrowLeftRightIcon className="h-4 w-4" />
                  </button>
                  {/* 1-16F : thème clair/sombre, avant la cloche (qui reste
                      immédiatement avant le nom). 1-16G : langue juste
                      avant le thème. */}
                  <LanguageSwitcher />
                  <ThemeToggle />
                  {/* 1-16A.1 : cloche du centre, juste avant le nom ; session
                      applicative avec contexte courant uniquement. */}
                  {contextIsCurrent &&
                    !commercialBlock &&
                    authContext &&
                    hasApplicationAccess(authContext) && (
                      <NotificationBell
                        key={`${sessionKey}:${authContext.organizationId}`}
                      />
                    )}
                  <span
                    className="hidden max-w-32 truncate text-sm text-muted-foreground sm:inline"
                    title={userFullName ?? undefined}
                    data-testid="user-first-name"
                  >
                    {firstNameOf(user.name) ?? t("shell.myAccount")}
                    {userFullName &&
                      userFullName !== firstNameOf(user.name) && (
                        <span className="sr-only"> ({userFullName})</span>
                      )}
                  </span>
                  <button
                    type="button"
                    onClick={handleLogout}
                    aria-label={t("shell.logout.button")}
                    className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <LogOutIcon className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Navigation métier desktop (1-9D) : source unique partagée avec
              la barre mobile ci-dessous — masquage par permission
              uniquement, le backend reste l'autorité par route. */}
              <div className="hidden border-t md:block">
                <div className="mx-auto flex max-w-4xl items-center gap-1 overflow-x-auto px-4 py-1.5 sm:px-6">
                  {navItems.map((item) => (
                    <ShellNavLink
                      key={item.href}
                      href={item.href}
                      offline={navOffline}
                      disabledClassName="cursor-not-allowed opacity-50 hover:bg-transparent"
                      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium hover:bg-muted ${
                        isActive(item.href)
                          ? "bg-(--tenant-accent-soft) text-(--tenant-accent-ink) ring-1 ring-inset ring-(--tenant-accent-border)"
                          : ""
                      }`}
                    >
                      <item.icon className="h-3.5 w-3.5" />
                      {t(`shell.nav.${item.key}`)}
                      {item.href === "/app/sales" && <PendingSalesNavBadge />}
                    </ShellNavLink>
                  ))}
                  {navOffline && (
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {t("shell.otherPagesOffline")}
                    </span>
                  )}
                </div>
              </div>
            </header>

            {/* 1-11C.3a : message hors ligne principal, unique. */}
            {navOffline && (
              <p
                role="status"
                className="mx-auto w-full max-w-4xl px-4 pt-3 text-sm text-muted-foreground sm:px-6"
              >
                {t("shell.offlineMessage")}
              </p>
            )}
            {brandingError && (
              <p
                role="alert"
                className="mx-auto w-full max-w-4xl px-4 pt-3 text-sm text-destructive sm:px-6"
              >
                {brandingError}
              </p>
            )}
            {listError && (
              <p
                role="alert"
                className="mx-auto w-full max-w-4xl px-4 pt-3 text-sm text-destructive sm:px-6"
              >
                {listError}
              </p>
            )}

            <main
              className={`flex flex-1 flex-col ${navOffline ? "pb-24 md:pb-16" : "pb-16"}`}
            >
              {/* 1-16A.1 : invitation installation / notifications, après
                  chargement du contexte, en session applicative seulement. */}
              {contextIsCurrent &&
                !commercialBlock &&
                authContext &&
                hasApplicationAccess(authContext) && (
                  <>
                    {/* 1-16C.2 : accord d'un compte existant, si le serveur
                        l'active ; ne bloque ni les ventes ni l'outbox. */}
                    <LegalAcceptancePrompt
                      key={`legal:${sessionKey}:${authContext.organizationId}`}
                      scope={`${authContext.userId}:${authContext.organizationId}`}
                    />
                    <EngagementPrompt
                      key={`${sessionKey}:${authContext.organizationId}`}
                    />
                  </>
                )}
              {statusUnavailable ? (
                <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
                  <p role="alert" className="text-sm">
                    {ts("manager.checkUnavailable")}
                  </p>
                  <button
                    type="button"
                    onClick={refreshShell}
                    className="inline-flex h-11 items-center justify-center rounded-md border px-4 text-sm font-medium hover:bg-muted"
                  >
                    {t("actions.retry")}
                  </button>
                  <PendingSalesIfAny />
                </div>
              ) : !contextReady || !contextIsCurrent ? (
                <p
                  role="status"
                  className="mx-auto mt-10 text-sm text-muted-foreground"
                >
                  {t("shell.loading")}
                </p>
              ) : accessRefused ? (
                <div
                  data-testid="access-refused"
                  className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-4 text-center"
                >
                  <p role="alert" className="text-sm text-muted-foreground">
                    {t("shell.accessRefused")}
                  </p>
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="inline-flex items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
                  >
                    {t("shell.logout.button")}
                  </button>
                  <PendingSalesIfAny />
                </div>
              ) : noActiveOrganization ? (
                <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
                  <p className="text-sm text-muted-foreground">
                    {t("shell.noOrganization")}
                  </p>
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="inline-flex items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
                  >
                    {t("shell.logout.button")}
                  </button>
                  <PendingSalesIfAny />
                </div>
              ) : (
                <Fragment key={contentGeneration}>{children}</Fragment>
              )}
            </main>

            <nav className="fixed inset-x-0 bottom-0 z-40 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
              {navOffline && (
                <p className="border-b px-4 py-0.5 text-center text-[11px] text-muted-foreground">
                  {t("shell.otherPagesOffline")}
                </p>
              )}
              <div className="flex h-16 items-stretch">
                {mobilePrimary.map((item) => (
                  <ShellNavLink
                    key={item.href}
                    href={item.href}
                    offline={navOffline}
                    disabledClassName="cursor-not-allowed opacity-40"
                    className={`relative flex flex-1 flex-col items-center justify-center gap-0.5 text-xs ${
                      isActive(item.href)
                        ? "font-medium text-(--tenant-accent-ink)"
                        : "text-muted-foreground"
                    }`}
                  >
                    {isActive(item.href) && (
                      <span
                        aria-hidden="true"
                        className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-(--tenant-accent)"
                      />
                    )}
                    <span className="relative">
                      <item.icon className="h-5 w-5" />
                      {item.href === "/app/sales" && (
                        <span className="absolute -right-2.5 -top-1.5">
                          <PendingSalesNavBadge />
                        </span>
                      )}
                    </span>
                    {t(`shell.nav.${item.key}`)}
                  </ShellNavLink>
                ))}
                {mobileCompact ? (
                  <button
                    type="button"
                    onClick={() => setPlusOpen(true)}
                    className="flex flex-1 flex-col items-center justify-center gap-0.5 text-xs text-muted-foreground"
                  >
                    <MoreHorizontalIcon className="h-5 w-5" />
                    {t("shell.more")}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="flex flex-1 flex-col items-center justify-center gap-0.5 text-xs text-muted-foreground"
                  >
                    <LogOutIcon className="h-5 w-5" />
                    {t("shell.quit")}
                  </button>
                )}
              </div>
            </nav>
          </div>

          {/* Menu « Plus » (mobile, >4 destinations visibles, 1-9D) : destinations
          restantes + utilitaires, jamais plus de 5 icônes dans la barre fixe. */}
          <Dialog open={plusOpen} onOpenChange={setPlusOpen}>
            {/* Portail hors de la racine du shell : jetons ré-appliqués. */}
            <DialogContent data-tenant-shell="" style={accentStyle}>
              <DialogHeader>
                <DialogTitle>{t("shell.more")}</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-1">
                {mobileOverflow.map((item) => (
                  <ShellNavLink
                    key={item.href}
                    href={item.href}
                    offline={navOffline}
                    onClick={() => setPlusOpen(false)}
                    disabledClassName="cursor-not-allowed opacity-50 hover:bg-transparent"
                    className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted ${
                      isActive(item.href)
                        ? "bg-(--tenant-accent-soft) text-(--tenant-accent-ink) ring-1 ring-inset ring-(--tenant-accent-border)"
                        : ""
                    }`}
                  >
                    <item.icon className="h-4 w-4" />
                    {t(`shell.nav.${item.key}`)}
                    {item.href === "/app/sales" && <PendingSalesNavBadge />}
                  </ShellNavLink>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setPlusOpen(false);
                    setConverterOpen(true);
                  }}
                  className="flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted"
                >
                  <ArrowLeftRightIcon className="h-4 w-4" />
                  {t("shell.converter")}
                </button>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-destructive hover:bg-muted"
                >
                  <LogOutIcon className="h-4 w-4" />
                  {t("shell.logout.button")}
                </button>
              </div>
            </DialogContent>
          </Dialog>

          <CurrencyConverter
            open={converterOpen}
            onOpenChange={setConverterOpen}
          />

          {logoutPending && (
            <LogoutPendingDialog
              operations={logoutPending}
              online={typeof navigator === "undefined" || navigator.onLine}
              canSync={authContext !== null}
              onCancel={cancelLogout}
              onSyncNow={syncBeforeLogout}
              onKeepAndLogout={finishLogout}
              onDeleteAndLogout={async () => {
                const ok = await deleteUserOperations(user._id);
                if (ok) await finishLogout();
                return ok;
              }}
            />
          )}
        </OfflineSalesProvider>
      </OrganizationShellContext.Provider>
    </SocketProvider>
  );
}
