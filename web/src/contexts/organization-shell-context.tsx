"use client";

import { createContext, useContext } from "react";
import type { ApiOrganizationCurrent } from "@/lib/api";

interface OrganizationShellValue {
  organization: ApiOrganizationCurrent | null;
}

export const OrganizationShellContext = createContext<OrganizationShellValue>({
  organization: null,
});

export function useOrganizationShell(): OrganizationShellValue {
  return useContext(OrganizationShellContext);
}
