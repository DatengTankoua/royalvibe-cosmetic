"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useT } from "next-i18next/client";
import { useLocale } from "@/i18n/locale-provider";
import { rich } from "@/i18n/rich";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { getApiErrorCode, getApiErrorMessage } from "@/lib/api";
import {
  confirmLegalAcceptance,
  fetchLegalAcceptanceStatus,
  legalAcceptanceErrorKey,
  type LegalAcceptanceErrorKey,
  matchesDisplayedVersions,
  type LegalAcceptanceStatus,
} from "@/lib/legal/acceptance";
import { legalDocumentById } from "@/lib/legal/site-identity";

/** Report « Plus tard » : pour la session du navigateur uniquement. */
export const LEGAL_PROMPT_DEFERRED_KEY = "stockmaster.legal.deferred";

function readDeferred(scope: string): boolean {
  try {
    return sessionStorage.getItem(LEGAL_PROMPT_DEFERRED_KEY) === scope;
  } catch {
    return false;
  }
}

function writeDeferred(scope: string): void {
  try {
    sessionStorage.setItem(LEGAL_PROMPT_DEFERRED_KEY, scope);
  } catch {
    // stockage indisponible : l'invite reviendra au prochain chargement
  }
}

// 1-16C.2 — Confirmation des conditions par un compte EXISTANT (créé avant
// l'acceptation versionnée, nouvelle version, ou nouveau propriétaire après
// un transfert). Règles :
// - aucune acceptation n'est supposée ni enregistrée sans clic explicite,
//   case non cochée d'avance ;
// - affichée seulement si le serveur l'active
//   (`LEGAL_ACCEPTANCE_PROMPT_ENABLED`), en ligne, en session applicative
//   (jamais sur l'écran de blocage commercial, qu'elle ne lève pas) ;
// - « Plus tard » ne bloque rien : ni l'application, ni les ventes, ni la
//   synchronisation des ventes hors connexion, qui s'exécute à part ;
// - si les versions affichées par ce navigateur diffèrent de celles du
//   serveur, seul un rechargement est proposé (aucun accord sur un texte
//   que la page ne montre pas).
export function LegalAcceptancePrompt({ scope }: { scope: string }) {
  const { t } = useT("legal");
  const { locale } = useLocale();
  const online = useOnlineStatus();
  const [status, setStatus] = useState<LegalAcceptanceStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  // Clé de traduction, ou message déjà traduit par l'API (1-16G).
  const [error, setError] = useState<
    { key: LegalAcceptanceErrorKey } | { text: string } | null
  >(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (!online || loaded.current || readDeferred(scope)) return;
    loaded.current = true;
    let cancelled = false;
    fetchLegalAcceptanceStatus()
      .then((s) => {
        if (cancelled) return;
        if (!s.promptEnabled || s.pending.length === 0) return;
        setStatus(s);
        setOpen(true);
      })
      .catch(() => {
        // Statut indisponible : rien n'est affiché ni supposé.
        loaded.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [online, scope]);

  if (!status) return null;
  const upToDate = matchesDisplayedVersions(status);
  const pendingDocs = status.pending
    .map((r) => legalDocumentById(r.id))
    .filter((d) => d !== undefined);
  const noticeDocs = status.notices
    .map((r) => legalDocumentById(r.id))
    .filter((d) => d !== undefined);

  const later = () => {
    writeDeferred(scope);
    setOpen(false);
  };

  const accept = async () => {
    if (!checked || busy || !online) return;
    setBusy(true);
    setError(null);
    try {
      await confirmLegalAcceptance(status, locale);
      setOpen(false);
      setStatus(null);
      toast.success(t("prompt.recorded"));
    } catch (err) {
      const key = legalAcceptanceErrorKey(getApiErrorCode(err));
      setError(key ? { key } : { text: getApiErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) later();
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("prompt.title")}</DialogTitle>
          <DialogDescription>
            {upToDate ? t("prompt.description") : t("prompt.outdated")}
          </DialogDescription>
        </DialogHeader>

        {upToDate ? (
          <div className="space-y-3 text-sm">
            <div className="flex items-start gap-3">
              <input
                id="legal-prompt-terms"
                type="checkbox"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
                disabled={busy}
                className="mt-0.5 size-5 shrink-0 accent-primary"
              />
              <label htmlFor="legal-prompt-terms" className="leading-relaxed">
                {t("acceptance.prefix")}{" "}
                {pendingDocs.map((doc, index) => (
                  <Fragment key={doc.id}>
                    {index > 0 &&
                      (index === pendingDocs.length - 1
                        ? t("acceptance.and")
                        : t("acceptance.comma"))}
                    {t("acceptance.article")}{" "}
                    <a
                      href={doc.href}
                      target="_blank"
                      rel="noopener"
                      className="font-medium underline underline-offset-2"
                    >
                      {t(`documents.${doc.id}.inSentence`)}
                      <span className="sr-only"> {t("acceptance.newTab")}</span>
                    </a>{" "}
                    {t("acceptance.versions", {
                      count: 1,
                      versions: doc.version,
                    })}
                  </Fragment>
                ))}
                .
              </label>
            </div>
            {noticeDocs.map((doc) => (
              <p key={doc.id} className="text-xs text-muted-foreground">
                {rich(t("prompt.notice", { version: doc.version }), {
                  doc: () => (
                    <a
                      href={doc.href}
                      target="_blank"
                      rel="noopener"
                      className="font-medium underline underline-offset-2"
                    >
                      {t(`documents.${doc.id}.inSentence`)}
                      <span className="sr-only"> {t("acceptance.newTab")}</span>
                    </a>
                  ),
                })}
              </p>
            ))}
            {!online && (
              <p role="status" className="text-xs text-muted-foreground">
                {t("prompt.offline")}
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {"key" in error ? t(error.key) : error.text}
              </p>
            )}
          </div>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={later}>
            {t("prompt.later")}
          </Button>
          {upToDate ? (
            <Button
              type="button"
              onClick={() => void accept()}
              disabled={!checked || busy || !online}
            >
              {busy ? t("prompt.saving") : t("prompt.accept")}
            </Button>
          ) : (
            <Button type="button" onClick={() => window.location.reload()}>
              {t("prompt.reload")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
