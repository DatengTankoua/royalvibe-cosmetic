"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Building2Icon, LogOutIcon, StoreIcon } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { OrganizationShellContext } from "@/contexts/organization-shell-context";
import { Wordmark } from "@/components/brand/wordmark";
import {
  fetchActiveOrganizations,
  fetchAuthContext,
  fetchCurrentOrganization,
  getApiErrorMessage,
  type ApiAuthContext,
  type ApiOrganizationCurrent,
  type SelectableOrganization,
} from "@/lib/api";

// Shell authentifié partagé pour les pages /app (1-9B/1-9C) : header desktop +
// navigation mobile fixe, branding organisation, switch multi-organisation,
// section « Organisation » (branding/membres/invitations).
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
      setAuthContext(
        authContextResult.status === "fulfilled"
          ? authContextResult.value
          : null,
      );
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
    logout();
    router.push("/auth/login");
  };

  if (isLoading || !user) return null;

  const isOrganizationSection = pathname.startsWith("/app/organization");

  return (
    <OrganizationShellContext.Provider
      value={{ organization, authContext, refreshShell }}
    >
      <div className="flex min-h-full flex-1 flex-col">
        <header className="sticky top-0 z-40 border-b bg-background">
          <div className="mx-auto flex h-14 max-w-4xl items-center gap-3 px-4 sm:px-6">
            <Wordmark className="text-base font-bold" />
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

            {/* Organisation : branding lisible par tout membre actif, pas
                de garde de permission sur ce lien (le backend reste
                l'autorité par route/onglet). */}
            <Link
              href="/app/organization"
              className={`hidden items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium hover:bg-muted sm:inline-flex ${
                isOrganizationSection ? "bg-muted" : ""
              }`}
            >
              <Building2Icon className="h-3.5 w-3.5" />
              Organisation
            </Link>

            <div className="ml-auto flex items-center gap-2">
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
        </header>

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
            <Link
              href="/app"
              className="flex flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium"
              style={{ color: "var(--brand-navy)" }}
            >
              <StoreIcon className="h-5 w-5" />
              Stock Master
            </Link>
            <Link
              href="/app/organization"
              className={`flex flex-1 flex-col items-center justify-center gap-0.5 text-xs ${
                isOrganizationSection ? "text-primary" : "text-muted-foreground"
              }`}
            >
              <Building2Icon className="h-5 w-5" />
              Organisation
            </Link>
            <button
              type="button"
              onClick={handleLogout}
              className="flex flex-1 flex-col items-center justify-center gap-0.5 text-xs text-muted-foreground"
            >
              <LogOutIcon className="h-5 w-5" />
              Quitter
            </button>
          </div>
        </nav>
      </div>
    </OrganizationShellContext.Provider>
  );
}
