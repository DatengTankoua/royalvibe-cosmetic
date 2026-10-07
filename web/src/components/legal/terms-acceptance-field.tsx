import { Fragment } from "react";
import {
  legalDocumentsFor,
  type LegalAcceptanceContext,
} from "@/lib/legal/acceptance";

// 1-16C.2 — Case d'acceptation des conditions, JAMAIS cochée d'avance.
// - La case ne couvre que les documents à ACCEPTER du parcours ; la
//   politique de confidentialité est une information, affichée à part et
//   sans accord.
// - Les liens s'ouvrent dans un nouvel onglet : la saisie en cours n'est pas
//   perdue.
// - Aucune autorisation facultative ni permission de notification ici.
const linkClass = "font-medium underline underline-offset-2";

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

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
          J&apos;ai lu et j&apos;accepte{" "}
          {documents.map((doc, index) => (
            <Fragment key={doc.id}>
              {index > 0 && (index === documents.length - 1 ? " et " : ", ")}
              les{" "}
              <a
                href={doc.href}
                target="_blank"
                rel="noopener"
                className={linkClass}
              >
                {lowerFirst(doc.title)}
                <span className="sr-only"> (nouvel onglet)</span>
              </a>
            </Fragment>
          ))}{" "}
          (version{documents.length > 1 ? "s" : ""}{" "}
          {documents.map((d) => d.version).join(" et ")}).
        </label>
      </div>
      {notices.map((doc) => (
        <p
          key={doc.id}
          className="text-xs leading-relaxed text-muted-foreground"
        >
          Pour savoir quelles données sont traitées et pourquoi, consulte la{" "}
          <a
            href={doc.href}
            target="_blank"
            rel="noopener"
            className={linkClass}
          >
            {lowerFirst(doc.title)}
            <span className="sr-only"> (nouvel onglet)</span>
          </a>{" "}
          (version {doc.version}). Elle t&apos;informe : la lire ne vaut pas
          accord.
        </p>
      ))}
    </div>
  );
}
