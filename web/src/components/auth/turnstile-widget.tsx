"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "next-i18next/client";
import { useLocale } from "@/i18n/locale-provider";
import { Button } from "@/components/ui/button";

// 1-18C — Widget Cloudflare Turnstile (inscription). Seule la clé de site
// PUBLIQUE est lue côté navigateur ; la clé secrète reste sur l'API, qui
// vérifie chaque jeton (hôte, action, usage unique) avant toute écriture.
// `NEXT_PUBLIC_TURNSTILE_SIMULATED=true` : case locale sans réseau pour les
// tests et la recette ; l'API ne l'accepte qu'en test ou en boucle locale.

const SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";
const SIMULATED = process.env.NEXT_PUBLIC_TURNSTILE_SIMULATED === "true";

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: Record<string, unknown>,
  ): string | undefined;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;

/** Script officiel chargé une fois, depuis l'URL exacte (jamais proxifié). */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () =>
      window.turnstile
        ? resolve(window.turnstile)
        : reject(new Error("turnstile"));
    script.onerror = () => {
      script.remove();
      reject(new Error("turnstile"));
    };
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    scriptPromise = null; // nouvel essai possible
    throw error;
  });
  return scriptPromise;
}

type WidgetState = "loading" | "ready" | "error" | "unconfigured";

interface TurnstileWidgetProps {
  /** Action attendue par l'API (≤ 32 car., [A-Za-z0-9_-]). */
  action: string;
  /** Jeton courant ; `null` = aucun jeton utilisable. */
  onToken: (token: string | null) => void;
  /** Incrémenté par le parent pour exiger une nouvelle vérification. */
  resetSignal: number;
  disabled?: boolean;
}

export function TurnstileWidget({
  action,
  onToken,
  resetSignal,
  disabled = false,
}: TurnstileWidgetProps) {
  const { t } = useT("auth");
  const { locale } = useLocale();
  const container = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);
  const [state, setState] = useState<WidgetState>(
    SIMULATED ? "ready" : SITE_KEY ? "loading" : "unconfigured",
  );
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [simulatedChecked, setSimulatedChecked] = useState(false);
  const onTokenRef = useRef(onToken);
  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  // Rendu du widget réel (une fois par tentative de chargement).
  useEffect(() => {
    if (SIMULATED || !SITE_KEY) return;
    let cancelled = false;
    loadTurnstile()
      .then((api) => {
        if (cancelled || !container.current) return;
        widgetId.current =
          api.render(container.current, {
            sitekey: SITE_KEY,
            action,
            language: locale,
            theme: "auto",
            size: "flexible",
            "refresh-expired": "auto",
            callback: (token: string) => {
              setFailed(false);
              onTokenRef.current(token);
            },
            "expired-callback": () => onTokenRef.current(null),
            "timeout-callback": () => onTokenRef.current(null),
            "error-callback": () => {
              setFailed(true);
              onTokenRef.current(null);
              return true;
            },
          }) ?? null;
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) {
        window.turnstile.remove(widgetId.current);
      }
      widgetId.current = null;
    };
  }, [action, locale, attempt]);

  const reset = useCallback(() => {
    onTokenRef.current(null);
    setFailed(false);
    setSimulatedChecked(false);
    if (widgetId.current && window.turnstile) {
      window.turnstile.reset(widgetId.current);
    }
  }, []);

  // Un jeton n'est valable qu'une fois : nouvelle vérification exigée.
  useEffect(() => {
    if (resetSignal > 0) reset();
  }, [resetSignal, reset]);

  if (state === "unconfigured") {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("register.antiBot.notConfigured")}
      </p>
    );
  }

  if (SIMULATED) {
    return (
      <label className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
        <input
          type="checkbox"
          className="size-5 shrink-0 accent-primary"
          checked={simulatedChecked}
          disabled={disabled}
          onChange={(e) => {
            setSimulatedChecked(e.target.checked);
            onTokenRef.current(
              e.target.checked
                ? `simulated-pass:${action}:${crypto.randomUUID()}`
                : null,
            );
          }}
        />
        {t("register.antiBot.simulated")}
      </label>
    );
  }

  return (
    <div className="space-y-2">
      {state === "loading" && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("register.antiBot.loading")}
        </p>
      )}
      <div ref={container} className="min-h-[65px] w-full" />
      {(state === "error" || failed) && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            {state === "error"
              ? t("register.antiBot.loadError")
              : t("register.antiBot.failed")}
          </p>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={disabled}
            onClick={() => {
              if (state === "error") {
                setState("loading");
                setAttempt((n) => n + 1);
              } else {
                reset();
              }
            }}
          >
            {t("register.antiBot.retry")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Vérification anti-robot disponible dans cette version du web. */
export const TURNSTILE_AVAILABLE = SIMULATED || SITE_KEY !== "";
