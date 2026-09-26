"use client";

import { createContext, useContext } from "react";
import type { ApiAuthContext, ApiOrganizationCurrent } from "@/lib/api";

interface OrganizationShellValue {
  organization: ApiOrganizationCurrent | null;
  // 1-9C : rôle/permissions effectives de la membership courante — jamais
  // `User.role`. `null` tant que non chargé ou en échec (masquage frontend
  // uniquement ; le backend reste l'autorité sur chaque route).
  authContext: ApiAuthContext | null;
  // Force un rechargement du branding/liste/contexte (ex. après édition du
  // branding) sans recharger toute la page.
  refreshShell: () => void;
}

export const OrganizationShellContext = createContext<OrganizationShellValue>({
  organization: null,
  authContext: null,
  refreshShell: () => {},
});

export function useOrganizationShell(): OrganizationShellValue {
  return useContext(OrganizationShellContext);
}
