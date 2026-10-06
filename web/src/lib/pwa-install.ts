// Installation de la PWA (1-16A.1) — détection avec les SEULS mécanismes
// réellement disponibles, sans prétendre à une détection parfaite :
// - mode autonome (`display-mode: standalone`, `navigator.standalone` iOS) :
//   l'application tourne installée ;
// - `appinstalled` (Chromium) : installation confirmée, mémorisée sur
//   l'appareil ;
// - `beforeinstallprompt` (Chromium) : installation proposée par le
//   navigateur, déclenchable au clic.
// Ailleurs (Firefox, Safari macOS…), l'état reste « inconnu » : aucune
// invitation d'installation n'est montrée.

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallState =
  "installed" | "promptable" | "ios-manual" | "unknown";

const INSTALLED_KEY = "stockmaster.pwa.installed";

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
let listening = false;

function notify() {
  for (const listener of listeners) listener();
}

function remember() {
  try {
    localStorage.setItem(INSTALLED_KEY, "1");
  } catch {
    // stockage indisponible : détection limitée au mode autonome
  }
}

/** À appeler au plus tôt (layout racine) : capture les événements. */
export function listenForInstallEvents(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    remember();
    notify();
  });
}

export function onInstallStateChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isAppleMobile(): boolean {
  const ua = navigator.userAgent;
  return (
    /iPhone|iPad|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  );
}

export function getInstallState(): InstallState {
  if (typeof window === "undefined") return "unknown";
  if (isStandalone()) return "installed";
  try {
    if (localStorage.getItem(INSTALLED_KEY) === "1") return "installed";
  } catch {
    // ignoré
  }
  if (deferred) return "promptable";
  if (isAppleMobile()) return "ios-manual";
  return "unknown";
}

/** Invite native (au clic uniquement) ; `false` si indisponible ou refusée. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  deferred = null;
  await event.prompt();
  const { outcome } = await event.userChoice;
  if (outcome === "accepted") remember();
  notify();
  return outcome === "accepted";
}
