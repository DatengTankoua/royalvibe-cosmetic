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
  "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-sm hover:bg-muted transition-colors";

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

  return (
    <>
      <header className="border-b bg-background">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-6">
          <Link href="/" className="flex items-center gap-2 mr-4">
            <Image
              src="/logo.jpg"
              alt="RoyalVibe"
              width={36}
              height={36}
              style={{ width: 36, height: 36 }}
              className="rounded-full object-cover"
            />
            <span className="font-bold text-base leading-tight hidden sm:block">
              RoyalVibe
              <br />
              <span className="text-xs font-normal text-muted-foreground">
                Cosmétiques & Bijoux
              </span>
            </span>
          </Link>

          <nav className="flex items-center gap-1 flex-1">
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
                title="Corbeille"
              >
                <Trash2Icon className="h-4 w-4" />
                <span className="hidden sm:inline">Corbeille</span>
              </Link>
            )}
            <button
              onClick={() => setConverterOpen(true)}
              className={navLink + " text-muted-foreground"}
              title="Convertisseur EUR ↔ CFA"
            >
              <ArrowLeftRightIcon className="h-4 w-4" />
              <span className="hidden sm:inline">EUR ↔ CFA</span>
            </button>
          </nav>

          <div className="flex items-center gap-3">
            {user ? (
              <>
                <span className="text-sm text-muted-foreground hidden sm:block">
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

      <CurrencyConverter open={converterOpen} onOpenChange={setConverterOpen} />
    </>
  );
}
