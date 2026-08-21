"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3Icon,
  ArrowLeftRightIcon,
  LayoutGridIcon,
  LogOutIcon,
  ShoppingBagIcon,
  Trash2Icon,
} from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { CurrencyConverter } from "@/components/currency/currency-converter";

const navLink =
  "inline-flex items-center gap-2 rounded-md px-2.5 py-1 text-sm hover:bg-muted transition-colors";

export function Navbar() {
  const { user, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [converterOpen, setConverterOpen] = useState(false);

  const isAuth = pathname.startsWith("/auth");
  if (isAuth) return null;

  const handleLogout = () => {
    logout();
    router.push("/auth/login");
  };

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  const bottomItemClass = (href: string) =>
    `flex flex-col items-center justify-center gap-0.5 flex-1 py-2 transition-colors ${
      isActive(href)
        ? "text-primary"
        : "text-muted-foreground hover:text-foreground"
    }`;

  const bottomBtnClass = () =>
    "flex flex-col items-center justify-center gap-0.5 flex-1 py-2 transition-colors text-muted-foreground hover:text-foreground";

  return (
    <>
      {/* ── Top header ── */}
      <header className="border-b bg-background sticky top-0 z-40">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2 sm:mr-4">
            <Image
              src="/logo.jpg"
              alt="RoyalVibe"
              width={36}
              height={36}
              style={{ width: 36, height: 36 }}
              className="rounded-full object-cover"
            />
            <span className="font-bold text-base leading-tight">
              RoyalVibe
              <br />
              <span className="text-xs font-normal text-muted-foreground hidden sm:inline">
                Cosmétiques & Bijoux
              </span>
            </span>
          </Link>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-1 flex-1">
            <Link href="/" className={navLink}>
              <LayoutGridIcon className="h-4 w-4" />
              Catalogue
            </Link>
            <Link href="/analytics" className={navLink}>
              <BarChart3Icon className="h-4 w-4" />
              Analytics
            </Link>
            {user && (
              <Link href="/sales" className={navLink}>
                <ShoppingBagIcon className="h-4 w-4" />
                Ventes
              </Link>
            )}
            {user?.role === "admin" && (
              <Link
                href="/corbeille"
                className={navLink + " text-muted-foreground"}
              >
                <Trash2Icon className="h-4 w-4" />
                Corbeille
              </Link>
            )}
            <button
              onClick={() => setConverterOpen(true)}
              className={navLink + " text-muted-foreground"}
              title="Convertisseur EUR ↔ CFA"
            >
              <ArrowLeftRightIcon className="h-4 w-4" />
              EUR ↔ CFA
            </button>
          </nav>

          {/* Mobile user (top-right, visible on small screens) */}
          {user && (
            <div className="flex md:hidden items-center gap-1 ml-auto">
              <span className="text-sm font-medium truncate max-w-[110px]">
                {user.name}
              </span>
              {user.role === "admin" && (
                <span className="text-xs bg-primary text-primary-foreground rounded px-1">
                  admin
                </span>
              )}
            </div>
          )}

          {/* Desktop user */}
          <div className="hidden md:flex items-center gap-3">
            {user ? (
              <>
                <span className="text-sm text-muted-foreground">
                  {user.name}
                  {user.role === "admin" && (
                    <span className="ml-1 text-xs bg-primary text-primary-foreground rounded px-1">
                      admin
                    </span>
                  )}
                </span>
                <button
                  onClick={handleLogout}
                  className={navLink + " text-muted-foreground"}
                  title="Se déconnecter"
                >
                  <LogOutIcon className="h-4 w-4" />
                </button>
              </>
            ) : (
              <Link
                href="/auth/login"
                className="inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/80 transition-colors"
              >
                Se connecter
              </Link>
            )}
          </div>
        </div>
      </header>

      {/* ── Bottom nav bar (mobile only) ── */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 flex h-16 items-stretch border-t bg-background">
        <Link href="/" className={bottomItemClass("/")}>
          <LayoutGridIcon className="h-5 w-5" />
          <span className="text-[10px]">Catalogue</span>
        </Link>

        <Link href="/analytics" className={bottomItemClass("/analytics")}>
          <BarChart3Icon className="h-5 w-5" />
          <span className="text-[10px]">Analytics</span>
        </Link>

        {user && (
          <Link href="/sales" className={bottomItemClass("/sales")}>
            <ShoppingBagIcon className="h-5 w-5" />
            <span className="text-[10px]">Ventes</span>
          </Link>
        )}

        {user?.role === "admin" && (
          <Link href="/corbeille" className={bottomItemClass("/corbeille")}>
            <Trash2Icon className="h-5 w-5" />
            <span className="text-[10px]">Corbeille</span>
          </Link>
        )}

        <button
          onClick={() => setConverterOpen(true)}
          className={bottomBtnClass()}
          aria-label="Convertisseur EUR ↔ CFA"
        >
          <ArrowLeftRightIcon className="h-5 w-5" />
          <span className="text-[10px]">EUR↔CFA</span>
        </button>

        {user && (
          <button
            onClick={handleLogout}
            className={bottomBtnClass()}
            aria-label="Se déconnecter"
          >
            <LogOutIcon className="h-5 w-5" />
            <span className="text-[10px]">Quitter</span>
          </button>
        )}
      </nav>

      <CurrencyConverter open={converterOpen} onOpenChange={setConverterOpen} />
    </>
  );
}
