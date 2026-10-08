"use client";

import { useEffect, useRef } from "react";
import { registerImageRenewal } from "@/lib/image-renewal";

/**
 * R2 privé — l'écran qui affiche des images signées fournit sa relecture
 * authentifiée (`request()` de `useLiveRefresh`) : elle est appelée, de
 * façon bornée, quand une de ses images ne se charge plus. `enabled =
 * false` : aucune relecture (ex. corbeille sans `trash.manage`).
 */
export function useImageRenewal(request: () => void, enabled = true): void {
  const requestRef = useRef(request);
  useEffect(() => {
    requestRef.current = request;
  });
  useEffect(() => {
    if (!enabled) return;
    return registerImageRenewal(() => requestRef.current());
  }, [enabled]);
}
