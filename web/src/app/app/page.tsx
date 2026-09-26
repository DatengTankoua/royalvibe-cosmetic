"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/contexts/auth-context";
import { Wordmark } from "@/components/brand/wordmark";

// Entrée authentifiée minimale (1-9A) : prépare le futur shell Stock Master
// sans migrer les pages métier existantes (catalogue reste sur "/").
export default function AppHomePage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !user) router.push("/auth/login");
  }, [user, isLoading, router]);

  if (isLoading || !user) return null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-6 px-4 py-12 text-center pb-[max(3rem,env(safe-area-inset-bottom))]">
      <Wordmark className="text-3xl font-extrabold tracking-tight" />
      <p className="text-sm text-muted-foreground">Bienvenue, {user.name}.</p>
      <Link
        href="/"
        className="inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium text-white"
        style={{ backgroundColor: "var(--brand-navy)" }}
      >
        Accéder au catalogue
      </Link>
    </div>
  );
}
