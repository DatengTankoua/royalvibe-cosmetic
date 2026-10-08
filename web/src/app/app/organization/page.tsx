"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// /app/organization redirige vers l'onglet par défaut (branding, lisible
// par tout membre actif — jamais un onglet nécessitant une permission).
export default function OrganizationIndexPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/app/organization/branding");
  }, [router]);
  return null;
}
