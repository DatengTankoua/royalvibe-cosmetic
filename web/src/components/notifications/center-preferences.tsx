"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useT } from "next-i18next/client";
import { getApiErrorMessage } from "@/lib/api";
import {
  CATEGORY_KEYS,
  CenterPreferences,
  fetchCenterPreferences,
  updateCenterPreferences,
} from "@/lib/notifications";
import type { PushPreferences } from "@/lib/push-notifications";

// 1-16A.1 — Préférences du centre (dans l'application, tous appareils).
// Une catégorie désactivée n'est plus créée et ses notifications existantes
// sont masquées. Seules les catégories autorisées au rôle sont proposées.
export function CenterPreferencesSection() {
  const { t } = useT("notifications");
  const [prefs, setPrefs] = useState<CenterPreferences | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchCenterPreferences()
      .then(setPrefs)
      .catch(() => setFailed(true));
  }, []);

  const toggle = async (key: keyof PushPreferences, value: boolean) => {
    if (!prefs) return;
    const previous = prefs;
    setPrefs({ ...prefs, categories: { ...prefs.categories, [key]: value } });
    setBusy(true);
    try {
      setPrefs(await updateCenterPreferences({ [key]: value }));
    } catch (error) {
      setPrefs(previous);
      toast.error(getApiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="max-w-md space-y-3">
      <div>
        <h2 className="text-lg font-semibold">{t("center.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("center.text")}</p>
      </div>
      {failed ? (
        <p className="text-sm text-muted-foreground">
          {t("center.unavailable")}
        </p>
      ) : !prefs ? (
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      ) : prefs.available.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noneForRole")}</p>
      ) : (
        <fieldset className="space-y-3" disabled={busy}>
          <legend className="sr-only">{t("center.legend")}</legend>
          {prefs.available.map((category) => {
            const key = CATEGORY_KEYS[category];
            return (
              <label key={category} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={prefs.categories[key]}
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
      )}
    </section>
  );
}
