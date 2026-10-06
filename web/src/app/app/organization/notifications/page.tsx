"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getApiErrorMessage } from "@/lib/api";
import { CATEGORY_LABELS } from "@/lib/notifications";
import { CenterPreferencesSection } from "@/components/notifications/center-preferences";
import {
  PushConfig,
  PushDeviceState,
  PushPermissionDeniedError,
  PushSupport,
  disablePushNotifications,
  enablePushNotifications,
  fetchPushConfig,
  fetchPushDeviceState,
  getNotificationPermission,
  getPushSupport,
  updatePushPreferences,
} from "@/lib/push-notifications";
import type { PushPreferences } from "@/lib/push-notifications";

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      config: PushConfig;
      device: PushDeviceState;
      support: PushSupport;
      permission: NotificationPermission | null;
    };

// Notifications Web Push (1-16A) — réglages de CET appareil pour le membre
// courant. La permission du navigateur n'est demandée qu'au clic sur
// « Activer les notifications ». Les messages restent génériques sur l'écran
// verrouillé ; le détail s'affiche dans l'application, selon les droits.
function PushSettings() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const support = getPushSupport();
      const config = await fetchPushConfig();
      const device =
        support === "supported" && config.enabled
          ? await fetchPushDeviceState()
          : { registered: false, preferences: null };
      setState({
        status: "ready",
        config,
        device,
        support,
        permission: getNotificationPermission(),
      });
    } catch {
      setState({ status: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === "loading") {
    return <p className="text-sm text-muted-foreground">Chargement…</p>;
  }
  if (state.status === "error") {
    return (
      <p className="text-sm text-muted-foreground">
        Réglages des notifications indisponibles pour le moment.
      </p>
    );
  }

  const { config, device, support, permission } = state;

  const enable = async () => {
    if (!config.publicKey) return;
    setBusy(true);
    try {
      await enablePushNotifications(config.publicKey);
      toast.success("Notifications activées sur cet appareil.");
    } catch (error) {
      toast.error(
        error instanceof PushPermissionDeniedError
          ? "Notifications refusées par le navigateur."
          : getApiErrorMessage(error),
      );
    } finally {
      setBusy(false);
      await load();
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      await disablePushNotifications();
      toast.success("Notifications désactivées sur cet appareil.");
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      setBusy(false);
      await load();
    }
  };

  // Affichage immédiat, puis état confirmé par le serveur (rétabli en cas
  // d'échec).
  const toggle = async (key: keyof PushPreferences, value: boolean) => {
    if (!device.preferences) return;
    setBusy(true);
    setState({
      ...state,
      device: {
        ...device,
        preferences: { ...device.preferences, [key]: value },
      },
    });
    try {
      const next = await updatePushPreferences({ [key]: value });
      setState({ ...state, device: next });
    } catch (error) {
      setState({ ...state, device });
      toast.error(getApiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  let notice: string | null = null;
  if (!config.enabled) {
    notice = "Les notifications ne sont pas disponibles sur ce service.";
  } else if (support === "unsupported") {
    notice = "Ce navigateur ne prend pas en charge les notifications push.";
  } else if (support === "ios-install-required") {
    notice =
      "Sur iPhone et iPad, les notifications ne sont proposées qu'à l'application ajoutée à l'écran d'accueil.";
  } else if (config.categories.length === 0) {
    notice = "Aucune notification n'est proposée pour votre rôle.";
  } else if (permission === "denied") {
    notice =
      "Les notifications sont bloquées pour ce site. Autorisez-les dans les réglages du navigateur, puis revenez ici.";
  }

  return (
    <div className="max-w-md space-y-5">
      <div>
        <h2 className="text-lg font-semibold">
          Notifications push sur cet appareil
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Recevez sur cet appareil les alertes importantes, même quand
          l&apos;application est fermée. Les messages restent volontairement
          généraux (aucun montant ni nom de produit sur l&apos;écran verrouillé)
          ; touchez la notification pour voir le détail.
        </p>
      </div>

      {notice && (
        <p
          role="status"
          className="rounded-md border px-3 py-2 text-sm text-muted-foreground"
        >
          {notice}
        </p>
      )}

      {!notice && !device.registered && (
        <Button onClick={() => void enable()} disabled={busy}>
          {busy ? "Activation…" : "Activer les notifications"}
        </Button>
      )}

      {device.registered && device.preferences && (
        <div className="space-y-4">
          <fieldset className="space-y-3" disabled={busy}>
            <legend className="text-sm font-medium">Me prévenir pour</legend>
            {config.categories.map((category) => {
              const { key, label, help } = CATEGORY_LABELS[category];
              return (
                <label
                  key={category}
                  className="flex items-start gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={device.preferences?.[key] ?? false}
                    onChange={(e) => void toggle(key, e.target.checked)}
                  />
                  <span>
                    {label}
                    <span className="block text-xs text-muted-foreground">
                      {help}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
          <Button
            variant="outline"
            onClick={() => void disable()}
            disabled={busy}
          >
            Désactiver les notifications
          </Button>
        </div>
      )}

      {config.enabled && support !== "supported" && (
        <div className="space-y-1 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">iPhone et iPad</p>
          <p>
            Ouvrez Stock Master dans Safari, touchez Partager puis « Sur
            l&apos;écran d&apos;accueil ». Lancez ensuite l&apos;application
            depuis son icône et revenez sur cette page pour activer les
            notifications (iOS / iPadOS 16.4 ou plus récent).
          </p>
        </div>
      )}
    </div>
  );
}

// 1-16A.1 — Deux réglages distincts : le centre de notifications dans
// l'application (tous les appareils de l'utilisateur, indépendant du push),
// puis le consentement push propre à CET appareil.
export default function NotificationsPage() {
  return (
    <div className="space-y-10">
      <CenterPreferencesSection />
      <PushSettings />
    </div>
  );
}
