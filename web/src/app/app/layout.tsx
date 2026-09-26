"use client";

import { useEffect, useRef, useState } from "react";
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
import { Wordmark } from "@/components/brand/wordmark";
import { OnlineStatusIndicator } from "@/components/layout/online-status-indicator";
import { CurrencyConverter } from "@/components/currency/currency-converter";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { hasPermission } from "@/lib/organization-permissions";
import { purgeAllOfflineData } from "@/lib/offline-purge";
import {
  writeIdentityPointer,
  readVerifiedIdentity,
} from "@/lib/offline-identity-db";
import { getToken } from "@/lib/auth";
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

// Shell authentifié partagé pour les pages /app (1-9B/1-9C/1-9D) : header
// desktop + navigation mobile fixe, branding organisation, switch
// multi-organisation, navigation métier (catalogue/ventes/analyse/corbeille/
// organisation) et connexion Socket.IO unique partagée par les pages migrées.
export default function AppShellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, isLoading, sessionVersion, logout, switchOrganization } =
    useAuth();
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
  const [loadingOrg, setLoadingOrg] = useState(true);
  // Indépendantes : l'échec de l'une ne doit jamais écraser le résultat
  // valide de l'autre (branding vs liste des organisations).
  const [brandingError, setBrandingError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Garde synchrone (l'état React ne se met à jour qu'au prochain rendu,
  // insuffisant contre un double-clic dans le même tick).
  const switchingRef = useRef(false);
  // Incrémenté pour forcer un rechargement du branding/liste/contexte sans
  // recharger toute la page (ex. après édition du branding, 1-9C).
  const [refreshTick, setRefreshTick] = useState(0);
  const refreshShell = () => setRefreshTick((v) => v + 1);
  const [converterOpen, setConverterOpen] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);

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
    // `allSettled` : une organisation courante suspendue (403) ne doit
    // jamais empêcher l'exploitation d'une liste d'organisations valide,
    // et vice-versa. Le contexte d'autorisation suit la même logique
    // (échec → section « Organisation » simplement masquée).
    Promise.allSettled([
      fetchCurrentOrganization(),
      fetchActiveOrganizations(),
      fetchAuthContext(),
    ]).then(([currentResult, listResult, authContextResult]) => {
      if (cancelled) return;
      if (currentResult.status === "fulfilled") {
        setOrganization(currentResult.value);
      } else {
        setOrganization(null);
        setBrandingError("Organisation actuelle indisponible.");
      }
      if (listResult.status === "fulfilled") {
        setOrganizations(listResult.value);
      } else {
        setListError(getApiErrorMessage(listResult.reason));
      }
      if (authContextResult.status === "fulfilled") {
        setAuthContext(authContextResult.value);
        setOfflineIdentity(null);
        const token = getToken();
        if (token) {
          void writeIdentityPointer({
            userId: authContextResult.value.userId,
            organizationId: authContextResult.value.organizationId,
            token,
          });
        }
      } else {
        setAuthContext(null);
        // Distinction stricte : une vraie panne réseau peut retomber sur
        // l'identité vérifiée localement ; une réponse HTTP (401/403/autre)
        // est une révocation/refus serveur — JAMAIS transformée en mode
        // hors ligne, fail-closed.
        if (isNetworkError(authContextResult.reason)) {
          void readVerifiedIdentity({ token: getToken() }).then((identity) => {
            if (!cancelled) setOfflineIdentity(identity);
          });
        } else {
          setOfflineIdentity(null);
        }
      }
      setLoadingOrg(false);
    });
    return () => {
      cancelled = true;
    };
  }, [user, sessionVersion, refreshTick]);

  // Organisations sélectionnables : jamais celle déjà courante (si connue).
  const alternatives = organizations.filter(
    (org) => org.organizationId !== organization?._id,
  );
  const noActiveOrganization =
    !loadingOrg && !listError && organizations.length === 0;

  const handleSwitch = async (organizationId: string) => {
    setMenuOpen(false);
    if (switchingRef.current || organizationId === organization?._id) return;
    switchingRef.current = true;
    setSwitching(true);
    try {
      await switchOrganization(organizationId);
      // Switch réussi uniquement : jamais purgé sur un switch échoué (catch
      // ci-dessous, avant même d'atteindre cette ligne).
      await purgeAllOfflineData();
      // Repart d'un état propre : contexte, branding, données métier et
      // socket sont tous rechargés avec le nouveau JWT en un seul geste.
      window.location.assign("/app");
    } catch (err: unknown) {
      setListError(
        err instanceof Error
          ? err.message
          : "Erreur de changement d'organisation",
      );
      switchingRef.current = false;
      setSwitching(false);
    }
  };

  const handleLogout = () => {
    void (async () => {
      await logout();
      router.push("/auth/login");
    })();
  };

  if (isLoading || !user) return null;

  const isActive = (href: string) =>
    href === "/app" ? pathname === "/app" : pathname.startsWith(href);

  return (
    <SocketProvider>
      <OrganizationShellContext.Provider
        value={{ organization, authContext, refreshShell, offlineIdentity }}
      >
        <div className="flex min-h-full flex-1 flex-col">
          <header className="sticky top-0 z-40 border-b bg-background">
            <div className="mx-auto flex h-16 max-w-4xl items-center gap-3 px-4 sm:px-6">
              <span className="hidden sm:inline-flex">
                <Wordmark size="medium" />
              </span>
              <span className="inline-flex sm:hidden">
                <Wordmark variant="icon" size="medium" />
              </span>
              <span
                className="hidden h-5 w-1 shrink-0 rounded-full sm:inline-block"
                style={{
                  backgroundColor:
                    organization?.brandColor ?? "var(--brand-orange)",
                }}
                aria-hidden="true"
              />
              <span className="hidden truncate text-sm text-muted-foreground sm:inline">
                {loadingOrg
                  ? "Chargement…"
                  : (organization?.name ?? brandingError)}
              </span>

              <div className="ml-auto flex items-center gap-2">
                <OnlineStatusIndicator />
                <button
                  type="button"
                  onClick={() => setConverterOpen(true)}
                  title="Convertisseur EUR ↔ CFA"
                  className="hidden rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground sm:inline-flex"
                >
                  <ArrowLeftRightIcon className="h-4 w-4" />
                </button>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setMenuOpen((v) => !v)}
                    disabled={switching || alternatives.length === 0}
                    aria-haspopup="listbox"
                    aria-expanded={menuOpen}
                    className="rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                  >
                    {switching ? "Changement…" : "Changer d'organisation"}
                  </button>
                  {menuOpen && (
                    <div
                      role="listbox"
                      aria-label="Organisations"
                      className="absolute right-0 z-50 mt-1 w-56 rounded-md border bg-popover p-1 shadow-md"
                    >
                      {alternatives.map((org) => (
                        <button
                          key={org.organizationId}
                          type="button"
                          role="option"
                          aria-selected={false}
                          onClick={() => void handleSwitch(org.organizationId)}
                          className="block w-full rounded px-2.5 py-1.5 text-left text-sm hover:bg-muted"
                        >
                          {org.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <span className="hidden text-sm text-muted-foreground sm:inline">
                  {user.name}
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
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium hover:bg-muted ${
                      isActive(item.href) ? "bg-muted text-primary" : ""
                    }`}
                  >
                    <item.icon className="h-3.5 w-3.5" />
                    {item.label}
                  </Link>
                ))}
              </div>
            </div>
          </header>

          {!authContext && offlineIdentity && (
            <p
              role="status"
              className="mx-auto w-full max-w-4xl px-4 pt-3 text-sm text-muted-foreground sm:px-6"
            >
              Mode hors connexion : identité vérifiée localement, données mises
              en cache uniquement.
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

          <main className="flex flex-1 flex-col pb-16">
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
              </div>
            ) : (
              children
            )}
          </main>

          <nav className="fixed inset-x-0 bottom-0 z-40 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
            <div className="flex h-16 items-stretch">
              {mobilePrimary.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex flex-1 flex-col items-center justify-center gap-0.5 text-xs ${
                    isActive(item.href)
                      ? "text-primary"
                      : "text-muted-foreground"
                  }`}
                >
                  <item.icon className="h-5 w-5" />
                  {item.label}
                </Link>
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
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Plus</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-1">
              {mobileOverflow.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setPlusOpen(false)}
                  className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted ${
                    isActive(item.href) ? "bg-muted text-primary" : ""
                  }`}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </Link>
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
      </OrganizationShellContext.Provider>
    </SocketProvider>
  );
}
