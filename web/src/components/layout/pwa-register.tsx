"use client";

import { useEffect } from "react";
import { listenForInstallEvents } from "@/lib/pwa-install";

export function PwaRegister() {
  useEffect(() => {
    // 1-16A.1 : capture précoce de `beforeinstallprompt` / `appinstalled`.
    listenForInstallEvents();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // SW registration failure is non-fatal
      });
    }
  }, []);
  return null;
}
