"use client";

import { Fragment } from "react";
import { useT } from "next-i18next/client";
import {
  legalDocumentsFor,
  type LegalAcceptanceContext,
} from "@/lib/legal/acceptance";
import { rich } from "@/i18n/rich";

// 1-16C.2 — Case d'acceptation des conditions, JAMAIS cochée d'avance.
// - La case ne couvre que les documents à ACCEPTER du parcours ; la
//   politique de confidentialité est une information, affichée à part et
//   sans accord.
// - Les liens s'ouvrent dans un nouvel onglet : la saisie en cours n'est pas
//   perdue.
// - Aucune autorisation facultative ni permission de notification ici.
// 1-16G : documents liés dans la langue de l'interface (même cookie).
const linkClass = "font-medium underline underline-offset-2";

export function TermsAcceptanceField({
  context,
  id,
  checked,
  onCheckedChange,
  disabled,
  invalid,
  errorId,
}: {
  context: LegalAcceptanceContext;
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  invalid?: boolean;
  errorId?: string;
}) {
  const { t } = useT("legal");
  const { documents, notices } = legalDocumentsFor(context);
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-3">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => onCheckedChange(e.target.checked)}
          disabled={disabled}
          required
          aria-invalid={invalid || undefined}
          aria-describedby={errorId}
          className="mt-0.5 size-5 shrink-0 accent-primary"
        />
        <label htmlFor={id} className="text-sm leading-relaxed">
          {t("acceptance.prefix")}{" "}
          {documents.map((doc, index) => (
            <Fragment key={doc.id}>
              {index > 0 &&
                (index === documents.length - 1
                  ? t("acceptance.and")
                  : t("acceptance.comma"))}
              {t("acceptance.article")}{" "}
              <a
                href={doc.href}
                target="_blank"
                rel="noopener"
                className={linkClass}
              >
                {t(`documents.${doc.id}.inSentence`)}
                <span className="sr-only"> {t("acceptance.newTab")}</span>
              </a>
            </Fragment>
          ))}{" "}
          {t("acceptance.versions", {
            count: documents.length,
            versions: documents.map((d) => d.version).join(t("acceptance.and")),
          })}
        </label>
      </div>
      {notices.map((doc) => (
        <p
          key={doc.id}
          className="text-xs leading-relaxed text-muted-foreground"
        >
          {rich(t("acceptance.notice", { version: doc.version }), {
            doc: () => (
              <a
                href={doc.href}
                target="_blank"
                rel="noopener"
                className={linkClass}
              >
                {t(`documents.${doc.id}.inSentence`)}
                <span className="sr-only"> {t("acceptance.newTab")}</span>
              </a>
            ),
          })}
        </p>
      ))}
    </div>
  );
}
