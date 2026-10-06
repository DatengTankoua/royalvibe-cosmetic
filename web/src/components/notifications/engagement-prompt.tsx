"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getApiErrorMessage } from "@/lib/api";
import {
  PushPermissionDeniedError,
  enablePushNotifications,
  fetchPushConfig,
  fetchPushDeviceState,
  getNotificationPermission,
  getPushSupport,
} from "@/lib/push-notifications";
import {
  InstallState,
  getInstallState,
  onInstallStateChange,
  promptInstall,
} from "@/lib/pwa-install";

/** Un modal au plus par 24 h et par appareil. */
export const ENGAGEMENT_MODAL_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const LAST_MODAL_KEY = "stockmaster.engagement.lastModalAt";
export const BANNER_HIDDEN_KEY = "stockmaster.engagement.bannerHidden";
/** Seul écran où un modal peut s'ouvrir : l'accueil (aucune saisie en cours). */
const MODAL_PATH = "/app";

type Invitation =
  | { kind: "install"; install: Exclude<InstallState, "installed" | "unknown"> }
  | { kind: "push"; publicKey: string }
  | { kind: "push-denied" };

function readNumber(storage: Storage, key: string): number | null {
  try {
    const value = Number(storage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function write(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // stockage indisponible : invitation simplement non mémorisée
  }
}

/** Un autre dialogue est ouvert, ou un formulaire est en cours de saisie. */
function busyScreen(): boolean {
  if (document.querySelector('[role="dialog"], [role="alertdialog"]')) {
    return true;
  }
  const active = document.activeElement;
  return (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLSelectElement
  );
}

// Invitations à installer la PWA et à activer les notifications (1-16A.1).
// - UNE seule invitation pertinente à la fois : installation si le navigateur
//   la propose (ou aide iPhone/iPad), sinon activation du push si le
//   navigateur ET le serveur le permettent ; permission refusée → aide aux
//   réglages, jamais de nouvel appel à `requestPermission`.
// - Au plus un modal par 24 h et par appareil, seulement sur l'accueil, sans
//   autre dialogue ouvert ni saisie en cours ; sinon une bannière discrète
//   (masquable pour la session).
// - La permission native n'est demandée qu'au clic sur « Activer ».
// - Aucun effet sur le hors ligne ni sur l'outbox des ventes.
export function EngagementPrompt() {
  const pathname = usePathname();
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [bannerHidden, setBannerHidden] = useState(
    () =>
      typeof window !== "undefined" &&
      (() => {
        try {
          return sessionStorage.getItem(BANNER_HIDDEN_KEY) === "1";
        } catch {
          return false;
        }
      })(),
  );
  const [busy, setBusy] = useState(false);

  const evaluate = useCallback(async () => {
    const install = getInstallState();
    if (install === "promptable" || install === "ios-manual") {
      setInvitation({ kind: "install", install });
      return;
    }
    if (getPushSupport() !== "supported") {
      setInvitation(null);
      return;
    }
    try {
      const config = await fetchPushConfig();
      if (
        !config.enabled ||
        !config.publicKey ||
        config.categories.length === 0
      ) {
        setInvitation(null);
        return;
      }
      const device = await fetchPushDeviceState();
      if (device.registered) {
        setInvitation(null);
        return;
      }
      setInvitation(
        getNotificationPermission() === "denied"
          ? { kind: "push-denied" }
          : { kind: "push", publicKey: config.publicKey },
      );
    } catch {
      setInvitation(null);
    }
  }, []);

  useEffect(() => {
    void evaluate();
    return onInstallStateChange(() => void evaluate());
  }, [evaluate]);

  // Modal : une fois par 24 h et par appareil, au bon moment seulement.
  useEffect(() => {
    if (!invitation || invitation.kind === "push-denied" || modalOpen) return;
    if (pathname !== MODAL_PATH || !navigator.onLine || busyScreen()) return;
    const last = readNumber(localStorage, LAST_MODAL_KEY);
    if (last !== null && Date.now() - last < ENGAGEMENT_MODAL_INTERVAL_MS) {
      return;
    }
    write(localStorage, LAST_MODAL_KEY, String(Date.now()));
    setModalOpen(true);
  }, [invitation, pathname, modalOpen]);

  const act = async () => {
    if (!invitation) return;
    setBusy(true);
    try {
      if (
        invitation.kind === "install" &&
        invitation.install === "promptable"
      ) {
        await promptInstall();
      } else if (invitation.kind === "push") {
        await enablePushNotifications(invitation.publicKey);
        toast.success("Notifications activées sur cet appareil.");
      }
    } catch (error) {
      toast.error(
        error instanceof PushPermissionDeniedError
          ? "Notifications refusées par le navigateur."
          : getApiErrorMessage(error),
      );
    } finally {
      setBusy(false);
      setModalOpen(false);
      await evaluate();
    }
  };

  const hideBanner = () => {
    write(sessionStorage, BANNER_HIDDEN_KEY, "1");
    setBannerHidden(true);
  };

  if (!invitation) return null;
  const text = describe(invitation);

  return (
    <>
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent data-testid="engagement-modal">
          <DialogHeader>
            <DialogTitle>{text.title}</DialogTitle>
            <DialogDescription>{text.body}</DialogDescription>
          </DialogHeader>
          {text.help && <p className="text-sm">{text.help}</p>}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setModalOpen(false);
                hideBanner();
              }}
            >
              Plus tard
            </Button>
            {text.action && (
              <Button onClick={() => void act()} disabled={busy}>
                {text.action}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {!modalOpen && !bannerHidden && (
        <div
          role="region"
          aria-label={text.title}
          data-testid="engagement-banner"
          className="mx-auto mt-3 flex w-full max-w-4xl flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm sm:mx-6 sm:w-auto"
        >
          <span className="min-w-0 flex-1">
            <span className="font-medium">{text.title}.</span>{" "}
            <span className="text-muted-foreground">
              {text.help ?? text.body}
            </span>
          </span>
          {text.action && (
            <Button size="sm" onClick={() => void act()} disabled={busy}>
              {text.action}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={hideBanner}>
            Plus tard
          </Button>
        </div>
      )}
    </>
  );
}

function describe(invitation: Invitation): {
  title: string;
  body: string;
  help?: string;
  action?: string;
} {
  switch (invitation.kind) {
    case "install":
      return invitation.install === "promptable"
        ? {
            title: "Installer Stock Master",
            body: "Ouvrez l'application depuis l'écran d'accueil, comme une application.",
            action: "Installer",
          }
        : {
            title: "Ajouter Stock Master à l'écran d'accueil",
            body: "Sur iPhone et iPad, l'application installée peut aussi recevoir des notifications.",
            help: "Dans Safari, touchez Partager puis « Sur l'écran d'accueil ».",
          };
    case "push":
      return {
        title: "Activer les notifications",
        body: "Soyez prévenu des ruptures de stock, des ventes et des échéances, même application fermée.",
        action: "Activer",
      };
    case "push-denied":
      return {
        title: "Notifications bloquées",
        body: "Les notifications sont refusées pour ce site sur cet appareil.",
        help: "Autorisez-les dans les réglages du navigateur (paramètres du site), puis rechargez la page.",
      };
  }
}
