"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowLeftRightIcon,
  BarChart3Icon,
  Building2Icon,
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
  deleteUserOperations,
  readUserUnfinalizedOperations,
  type OutboxOperation,
} from "@/lib/offline-sales-outbox-db";
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
import {
  ORGANIZATION_NAME_FALLBACK,
  firstNameOf,
  fullNameOf,
} from "@/lib/display-names";
import { useOfflineSalesSync } from "@/hooks/use-offline-sales-sync";
import { useOnlineStatus } from "@/hooks/use-online-status";
import {
  fetchActiveOrganizations,
  fetchAuthContext,
  fetchCurrentOrganization,
  getApiErrorMessage,
  isNetworkError,
  type ApiAuthContext,
  type ApiOrganizationCurrent,
  type SelectableOrganization,
} from "@/lib/api";

interface ShellNavItem {
  href: string;
  label: string;
  icon: typeof StoreIcon;
}

// Navigation des pages métier (1-9D) : masquage UX uniquement — filtrée par
// `authContext.effectivePermissions`, jamais `User.role`/`ApiUser.role`. La
// sécurité backend reste l'autorité finale sur chaque route.
function visibleNavItems(authContext: ApiAuthContext | null): ShellNavItem[] {
  const items: Array<ShellNavItem & { visible: boolean }> = [
    { href: "/app", label: "Accueil", icon: StoreIcon, visible: true },
    {
      href: "/app/catalog",
      label: "Catalogue",
      icon: LayoutGridIcon,
      visible: true,
    },
    {
      href: "/app/sales",
      label: "Ventes",
      icon: ShoppingBagIcon,
      visible:
        hasPermission(authContext, "sales.view_own") ||
        hasPermission(authContext, "sales.view_all") ||
        hasPermission(authContext, "sales.record"),
    },
    {
      href: "/app/analytics",
      label: "Analyse",
      icon: BarChart3Icon,
      visible: hasPermission(authContext, "analytics.read"),
    },
    {
      href: "/app/trash",
      label: "Corbeille",
      icon: Trash2Icon,
      visible: hasPermission(authContext, "trash.manage"),
    },
    {
      href: "/app/organization",
      label: "Organisation",
      icon: Building2Icon,
      visible: true,
    },
  ];
  return items.filter((i) => i.visible);
}

const MOBILE_PRIMARY_COUNT = 4;

// Correctif 1-11C.3 : seule route /app servie hors ligne par le service
// worker (document d'app shell précaché).
const OFFLINE_AVAILABLE_HREF = "/app/catalog";
const OFFLINE_UNAVAILABLE_LABEL = "Indisponible hors connexion";
const OFFLINE_MAIN_MESSAGE =
  "Vous êtes hors connexion. Vous pouvez consulter les données enregistrées sur cet appareil et saisir des ventes qui seront envoyées au retour de la connexion.";

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
      title={OFFLINE_UNAVAILABLE_LABEL}
      className={`${className} ${disabledClassName}`}
    >
      {children}
      <span className="sr-only"> — {OFFLINE_UNAVAILABLE_LABEL}</span>
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
  const { user, isLoading, sessionVersion, logout } = useAuth();
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
  const [brandingError, setBrandingError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  // Liste réellement reçue : « aucune organisation active » ne se déduit
  // jamais d'une liste non chargée (ex. hors ligne).
  const [listLoaded, setListLoaded] = useState(false);
  // Incrémenté pour forcer un rechargement du branding/liste/contexte sans
  // recharger toute la page (ex. après édition du branding, 1-9C).
  const [refreshTick, setRefreshTick] = useState(0);
  const refreshShell = () => setRefreshTick((v) => v + 1);
  const [converterOpen, setConverterOpen] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);

  // 1-11C.2 : synchronisation des ventes hors ligne — partition issue du
  // contexte SERVEUR uniquement ; inactive sans contexte ou file vide.
  useOfflineSalesSync(authContext);

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
    if (!isLoading && !user) router.push("/auth/login");
  }, [user, isLoading, router]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoadingOrg(true);
    setBrandingError(null);
    setListError(null);
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
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      void readOfflineFallback().then(({ identity, brand }) => {
        if (cancelled || contextSettled) return;
        setOfflineIdentity(identity);
        setOfflineBrand(brand);
      });
    }
    // `allSettled` : une organisation courante suspendue (403) ne doit
    // jamais empêcher l'exploitation d'une liste d'organisations valide,
    // et vice-versa. Le contexte d'autorisation suit la même logique
    // (échec → section « Organisation » simplement masquée).
    Promise.allSettled([
      fetchCurrentOrganization(),
      fetchActiveOrganizations(),
      fetchAuthContext(),
    ]).then(([currentResult, listResult, authContextResult]) => {
      contextSettled = true;
      if (cancelled) return;
      if (currentResult.status === "fulfilled") {
        setOrganization(currentResult.value);
      } else {
        setOrganization(null);
        // 1-11C.3a : une panne réseau n'est pas une erreur à afficher (le
        // message hors ligne unique du shell suffit) ; seul un refus serveur
        // est signalé.
        if (!isNetworkError(currentResult.reason)) {
          setBrandingError("Organisation actuelle indisponible.");
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
      if (authContextResult.status === "fulfilled") {
        setAuthContext(authContextResult.value);
        setOfflineIdentity(null);
        setOfflineBrand(null);
        // 1-12A : snapshot visuel écrit seulement si les DEUX réponses ont
        // réussi et désignent la même organisation (champs recopiés un à un,
        // jamais la réponse brute).
        if (
          currentResult.status === "fulfilled" &&
          currentResult.value._id === authContextResult.value.organizationId
        ) {
          void writeTenantBrand({
            userId: authContextResult.value.userId,
            organizationId: authContextResult.value.organizationId,
            organizationName: currentResult.value.name,
            brandColor: currentResult.value.brandColor,
          });
        }
        const token = getToken();
        if (token) {
          // 1-11C.2 : pointeur écrit → le moteur peut vérifier l'identité.
          void writeIdentityPointer({
            userId: authContextResult.value.userId,
            organizationId: authContextResult.value.organizationId,
            token,
          }).then((written) => {
            if (written && !cancelled) requestOfflineSalesSync();
          });
          // 1-11C.3 : capacité minimale de saisie hors ligne (booléen seul),
          // liée à l'identité et au token courants, TTL 72 h.
          void writeSalesCapability({
            userId: authContextResult.value.userId,
            organizationId: authContextResult.value.organizationId,
            token,
            canRecordSales: hasPermission(
              authContextResult.value,
              "sales.record",
            ),
          });
        }
      } else {
        setAuthContext(null);
        // Distinction stricte : une vraie panne réseau peut retomber sur
        // l'identité vérifiée localement ; une réponse HTTP (401/403/autre)
        // est une révocation/refus serveur — JAMAIS transformée en mode
        // hors ligne, fail-closed.
        if (isNetworkError(authContextResult.reason)) {
          void readOfflineFallback().then(({ identity, brand }) => {
            if (cancelled) return;
            setOfflineIdentity(identity);
            setOfflineBrand(brand);
          });
        } else {
          setOfflineIdentity(null);
          setOfflineBrand(null);
          // Refus serveur : plus aucune saisie hors ligne sur cet appareil,
          // ni identité visuelle du commerce.
          void clearSalesCapability();
          void clearTenantBrand();
        }
      }
      setLoadingOrg(false);
    });
    return () => {
      cancelled = true;
    };
  }, [user, sessionVersion, refreshTick]);

  const noActiveOrganization =
    !loadingOrg && listLoaded && organizations.length === 0;

  // 1-11C.3 : déconnexion volontaire. Worker arrêté, puis recensement des
  // ventes locales non finalisées de TOUTES les organisations de
  // l'utilisateur : aucune → logout normal ; sinon choix explicite
  // (synchroniser, exporter, conserver, supprimer). Jamais de suppression
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
          toast.warning(
            "Ventes locales non vérifiées : elles restent conservées sur cet appareil.",
          );
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
      toast.success("Ventes synchronisées.");
      return;
    }
    if (remaining !== null) setLogoutPending(remaining);
    toast.info(
      "Certaines ventes restent en attente (autre organisation, conflit ou réseau).",
    );
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

  return (
    <SocketProvider>
      <OrganizationShellContext.Provider
        value={{ organization, authContext, refreshShell, offlineIdentity }}
      >
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
                        aria-label="Chargement"
                      />
                    ) : (
                      <span
                        className="truncate text-sm font-semibold sm:text-base"
                        data-testid="tenant-name"
                      >
                        {organizationName ?? ORGANIZATION_NAME_FALLBACK}
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
                    title="Convertisseur EUR ↔ CFA"
                    className="hidden rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground sm:inline-flex"
                  >
                    <ArrowLeftRightIcon className="h-4 w-4" />
                  </button>
                  <span
                    className="hidden max-w-32 truncate text-sm text-muted-foreground sm:inline"
                    title={userFullName ?? undefined}
                    data-testid="user-first-name"
                  >
                    {firstNameOf(user.name)}
                    {userFullName &&
                      userFullName !== firstNameOf(user.name) && (
                        <span className="sr-only"> ({userFullName})</span>
                      )}
                  </span>
                  <button
                    type="button"
                    onClick={handleLogout}
                    aria-label="Se déconnecter"
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
                      {item.label}
                      {item.href === "/app/sales" && <PendingSalesNavBadge />}
                    </ShellNavLink>
                  ))}
                  {navOffline && (
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      Autres pages : {OFFLINE_UNAVAILABLE_LABEL.toLowerCase()}
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
                {OFFLINE_MAIN_MESSAGE}
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
              {noActiveOrganization ? (
                <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
                  <p className="text-sm text-muted-foreground">
                    Aucune organisation active. Contacte un administrateur ou
                    déconnecte-toi.
                  </p>
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="inline-flex items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
                  >
                    Se déconnecter
                  </button>
                  <PendingSalesIfAny />
                </div>
              ) : (
                children
              )}
            </main>

            <nav className="fixed inset-x-0 bottom-0 z-40 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
              {navOffline && (
                <p className="border-b px-4 py-0.5 text-center text-[11px] text-muted-foreground">
                  Autres pages : {OFFLINE_UNAVAILABLE_LABEL.toLowerCase()}
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
                    {item.label}
                  </ShellNavLink>
                ))}
                {mobileCompact ? (
                  <button
                    type="button"
                    onClick={() => setPlusOpen(true)}
                    className="flex flex-1 flex-col items-center justify-center gap-0.5 text-xs text-muted-foreground"
                  >
                    <MoreHorizontalIcon className="h-5 w-5" />
                    Plus
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="flex flex-1 flex-col items-center justify-center gap-0.5 text-xs text-muted-foreground"
                  >
                    <LogOutIcon className="h-5 w-5" />
                    Quitter
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
                <DialogTitle>Plus</DialogTitle>
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
                    {item.label}
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
                  Convertisseur EUR ↔ CFA
                </button>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-destructive hover:bg-muted"
                >
                  <LogOutIcon className="h-4 w-4" />
                  Se déconnecter
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
