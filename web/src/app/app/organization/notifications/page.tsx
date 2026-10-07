"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useT } from "next-i18next/client";
import { Button } from "@/components/ui/button";
import { getApiErrorMessage } from "@/lib/api";
import { CATEGORY_KEYS } from "@/lib/notifications";
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
  const { t } = useT("notifications");
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
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>;
  }
  if (state.status === "error") {
    return (
      <p className="text-sm text-muted-foreground">{t("push.unavailable")}</p>
    );
  }

  const { config, device, support, permission } = state;

  const enable = async () => {
    if (!config.publicKey) return;
    setBusy(true);
    try {
      await enablePushNotifications(config.publicKey);
      toast.success(t("push.enabled"));
    } catch (error) {
      toast.error(
        error instanceof PushPermissionDeniedError
          ? t("push.denied")
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
      toast.success(t("push.disabled"));
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
    notice = t("push.notices.disabled");
  } else if (support === "unsupported") {
    notice = t("push.notices.unsupported");
  } else if (support === "ios-install-required") {
    notice = t("push.notices.iosInstall");
  } else if (config.categories.length === 0) {
    notice = t("noneForRole");
  } else if (permission === "denied") {
    notice = t("push.notices.blocked");
  }

  return (
    <div className="max-w-md space-y-5">
      <div>
        <h2 className="text-lg font-semibold">{t("push.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("push.text")}</p>
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
          {busy ? t("push.enabling") : t("push.enable")}
        </Button>
      )}

      {device.registered && device.preferences && (
        <div className="space-y-4">
          <fieldset className="space-y-3" disabled={busy}>
            <legend className="text-sm font-medium">{t("push.legend")}</legend>
            {config.categories.map((category) => {
              const key = CATEGORY_KEYS[category];
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
                    {t(`categories.${key}.label`)}
                    <span className="block text-xs text-muted-foreground">
                      {t(`categories.${key}.help`)}
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
            {t("push.disable")}
          </Button>
        </div>
      )}

      {config.enabled && support !== "supported" && (
        <div className="space-y-1 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">{t("push.iosTitle")}</p>
          <p>{t("push.iosHelp")}</p>
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
