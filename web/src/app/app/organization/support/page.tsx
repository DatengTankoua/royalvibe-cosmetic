"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CheckCircle2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { ROLE_LABELS } from "@/lib/organization-permissions";
import {
  SUPPORT_CATEGORIES,
  SUPPORT_ERROR_MESSAGES,
  SUPPORT_MESSAGE_MAX_LENGTH,
  SUPPORT_SUBJECT_MAX_LENGTH,
  classifySupportError,
  fetchSupportContext,
  publicAppVersion,
  safeSupportPage,
  submitSupportRequest,
  supportErrorReference,
  type SupportCategory,
  type SupportContext,
  type SupportErrorKind,
  type SupportSubmitResult,
} from "@/lib/support";

// 1-16C.1 — Organisation → Assistance. Visible et utilisable seulement
// avec `support.contact` ; le serveur revérifie session, appartenance,
// abonnement et droit à chaque requête. Le brouillon reste en mémoire de
// la page : jamais dans l'outbox des ventes ni dans un stockage local.
// Un UUID par intention : conservé pour réessayer le MÊME contenu, renouvelé
// dès que le contenu change après un essai ou après un succès.

type FieldErrors = Partial<Record<"category" | "subject" | "message", string>>;

function newRequestId(): string {
  return crypto.randomUUID();
}

// `useSearchParams` (paramètre facultatif `depuis`) : frontière Suspense
// requise par le prérendu de Next.
export default function SupportPage() {
  return (
    <Suspense
      fallback={
        <p role="status" className="text-sm text-muted-foreground">
          Chargement…
        </p>
      }
    >
      <SupportForm />
    </Suspense>
  );
}

function SupportForm() {
  const { authContext } = useOrganizationShell();
  const online = useOnlineStatus();
  const searchParams = useSearchParams();
  const page = safeSupportPage(searchParams.get("depuis"));
  const canContact =
    authContext?.effectivePermissions.includes("support.contact") ?? false;

  const [context, setContext] = useState<SupportContext | null>(null);
  const [contextError, setContextError] = useState<SupportErrorKind | null>(
    null,
  );
  const [category, setCategory] = useState<SupportCategory | "">("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{
    kind: SupportErrorKind;
    reference?: string;
  } | null>(null);
  const [sent, setSent] = useState<SupportSubmitResult | null>(null);

  const requestId = useRef<string>("");
  const attempted = useRef(false);
  const submitting = useRef(false);
  const formId = useId();
  const categoryRef = useRef<HTMLSelectElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const sentTitleRef = useRef<HTMLHeadingElement>(null);

  // Confirmation : le focus va au titre (annonce aux lecteurs d'écran).
  useEffect(() => {
    if (sent) sentTitleRef.current?.focus();
  }, [sent]);

  // Aucune requête protégée sans le droit (accès direct par URL).
  useEffect(() => {
    if (!authContext || !canContact) return;
    let cancelled = false;
    fetchSupportContext()
      .then((data) => {
        if (!cancelled) setContext(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setContextError(classifySupportError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [authContext, canContact]);

  // Contenu modifié après un essai : nouvelle intention (nouvel UUID).
  const edited = useCallback(() => {
    if (attempted.current) {
      requestId.current = "";
      attempted.current = false;
    }
  }, []);

  const validate = (): FieldErrors => {
    const errors: FieldErrors = {};
    if (!category) errors.category = "Choisissez une catégorie.";
    if (subject.trim().length === 0) errors.subject = "Indiquez un sujet.";
    if (message.trim().length === 0) errors.message = "Écrivez votre message.";
    return errors;
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting.current) return; // double clic : un seul envoi
    const errors = validate();
    setFieldErrors(errors);
    if (errors.category) return categoryRef.current?.focus();
    if (errors.subject) return subjectRef.current?.focus();
    if (errors.message) return messageRef.current?.focus();
    if (!online) {
      setError({ kind: "offline" });
      return;
    }

    if (!requestId.current) requestId.current = newRequestId();
    submitting.current = true;
    attempted.current = true;
    setSending(true);
    setError(null);
    try {
      const result = await submitSupportRequest({
        requestId: requestId.current,
        category: category as SupportCategory,
        subject,
        message,
        page,
        appVersion: publicAppVersion(),
      });
      setSent(result);
    } catch (err: unknown) {
      const kind = classifySupportError(err);
      if (kind === "conflict") {
        // Contenu différent du premier essai : nouvelle intention.
        requestId.current = "";
        attempted.current = false;
      }
      setError({ kind, reference: supportErrorReference(err) });
    } finally {
      submitting.current = false;
      setSending(false);
    }
  };

  const startNew = () => {
    setSent(null);
    setCategory("");
    setSubject("");
    setMessage("");
    setFieldErrors({});
    setError(null);
    requestId.current = "";
    attempted.current = false;
  };

  if (!authContext) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Chargement…
      </p>
    );
  }

  if (!canContact || contextError === "forbidden") {
    return (
      <section aria-labelledby="support-title" className="max-w-xl space-y-3">
        <h2 id="support-title" className="text-lg font-semibold">
          Assistance
        </h2>
        <p className="text-sm text-muted-foreground">
          Votre rôle ne permet pas de contacter le service client depuis ce
          commerce. Demandez ce droit au propriétaire ou à un administrateur, ou
          utilisez les coordonnées de la page{" "}
          <Link href="/contact" className="underline underline-offset-2">
            Contact
          </Link>
          .
        </p>
      </section>
    );
  }

  if (sent) {
    return (
      <section
        aria-labelledby="support-sent-title"
        className="max-w-xl rounded-xl border border-emerald-600/30 bg-emerald-50 p-5 dark:bg-emerald-500/10"
      >
        <div className="flex items-start gap-3">
          <CheckCircle2Icon
            className="mt-0.5 size-5 shrink-0 text-emerald-700"
            aria-hidden
          />
          <div className="min-w-0 space-y-2">
            <h2
              id="support-sent-title"
              className="text-base font-semibold"
              tabIndex={-1}
              ref={sentTitleRef}
            >
              Message transmis
            </h2>
            <p className="text-sm">
              Référence de votre demande :{" "}
              <strong className="font-mono">{sent.reference}</strong>
            </p>
            <p className="text-sm text-muted-foreground">
              Le service d&apos;envoi a accepté votre message. Cela ne confirme
              pas encore sa lecture : la réponse arrivera à{" "}
              {context?.user.email ?? "votre adresse e-mail"}. Citez la
              référence si vous écrivez à nouveau.
            </p>
            <Button type="button" variant="outline" onClick={startNew}>
              Écrire un autre message
            </Button>
          </div>
        </div>
      </section>
    );
  }

  const describe = (field: keyof FieldErrors, hint: string) =>
    fieldErrors[field] ? `${hint} ${formId}-${field}-error` : hint;

  return (
    <section aria-labelledby="support-title" className="max-w-2xl space-y-6">
      <div className="space-y-1">
        <h2 id="support-title" className="text-lg font-semibold">
          Contacter le service client
        </h2>
        <p className="text-sm text-muted-foreground">
          Décrivez votre question ou votre problème. La réponse arrivera par
          e-mail.
        </p>
      </div>

      {!online && (
        <p
          role="status"
          className="rounded-lg border border-amber-500/40 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200"
        >
          Pas de connexion : l&apos;envoi nécessite Internet. Vous pouvez
          continuer à écrire, votre texte reste sur cet écran.
        </p>
      )}

      <form
        onSubmit={(e) => void handleSubmit(e)}
        noValidate
        className="space-y-5"
        aria-busy={sending}
      >
        <div className="space-y-2">
          <Label htmlFor={`${formId}-category`}>Catégorie</Label>
          <select
            id={`${formId}-category`}
            ref={categoryRef}
            value={category}
            onChange={(e) => {
              edited();
              setCategory(e.target.value as SupportCategory);
            }}
            aria-invalid={Boolean(fieldErrors.category)}
            aria-describedby={
              fieldErrors.category ? `${formId}-category-error` : undefined
            }
            className="h-11 w-full rounded-md border bg-background px-3 text-base sm:max-w-xs sm:text-sm"
          >
            <option value="">Choisir…</option>
            {SUPPORT_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          {fieldErrors.category && (
            <p
              id={`${formId}-category-error`}
              className="text-sm text-destructive"
            >
              {fieldErrors.category}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor={`${formId}-subject`}>Sujet</Label>
          <Input
            id={`${formId}-subject`}
            ref={subjectRef}
            value={subject}
            maxLength={SUPPORT_SUBJECT_MAX_LENGTH}
            autoComplete="off"
            onChange={(e) => {
              edited();
              setSubject(e.target.value);
            }}
            aria-invalid={Boolean(fieldErrors.subject)}
            aria-describedby={describe("subject", `${formId}-subject-count`)}
            className="h-11 text-base sm:text-sm"
          />
          <p
            id={`${formId}-subject-count`}
            className="text-xs text-muted-foreground tabular-nums"
          >
            {subject.length} / {SUPPORT_SUBJECT_MAX_LENGTH} caractères
          </p>
          {fieldErrors.subject && (
            <p
              id={`${formId}-subject-error`}
              className="text-sm text-destructive"
            >
              {fieldErrors.subject}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor={`${formId}-message`}>Message</Label>
          <Textarea
            id={`${formId}-message`}
            ref={messageRef}
            value={message}
            rows={7}
            maxLength={SUPPORT_MESSAGE_MAX_LENGTH}
            onChange={(e) => {
              edited();
              setMessage(e.target.value);
            }}
            aria-invalid={Boolean(fieldErrors.message)}
            aria-describedby={describe("message", `${formId}-message-count`)}
            className="text-base sm:text-sm"
          />
          <p
            id={`${formId}-message-count`}
            className="text-xs text-muted-foreground tabular-nums"
          >
            {message.length} / {SUPPORT_MESSAGE_MAX_LENGTH} caractères
          </p>
          {fieldErrors.message && (
            <p
              id={`${formId}-message-error`}
              className="text-sm text-destructive"
            >
              {fieldErrors.message}
            </p>
          )}
        </div>

        <section
          aria-labelledby={`${formId}-context-title`}
          className="rounded-xl border bg-muted/40 p-4"
        >
          <h3 id={`${formId}-context-title`} className="text-sm font-semibold">
            Informations transmises au service client
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Elles sont jointes automatiquement à votre message pour retrouver
            votre compte et votre commerce. Elles ne sont pas modifiables ici.
            Aucune vente, aucun contact d&apos;acheteur, aucun fichier ni mot de
            passe n&apos;est joint.
          </p>
          {context ? (
            <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
              <dt className="text-muted-foreground">Nom</dt>
              <dd className="min-w-0 break-words">{context.user.name}</dd>
              <dt className="text-muted-foreground">E-mail (réponse)</dt>
              <dd className="min-w-0 break-all">{context.user.email}</dd>
              <dt className="text-muted-foreground">Commerce</dt>
              <dd className="min-w-0 break-words">
                {context.organization.name}
              </dd>
              <dt className="text-muted-foreground">Rôle</dt>
              <dd>
                {ROLE_LABELS[
                  context.membership.role as keyof typeof ROLE_LABELS
                ] ?? context.membership.role}
              </dd>
              {page && (
                <>
                  <dt className="text-muted-foreground">Page concernée</dt>
                  <dd className="min-w-0 break-all font-mono text-xs">
                    {page}
                  </dd>
                </>
              )}
            </dl>
          ) : contextError ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {SUPPORT_ERROR_MESSAGES[contextError]}
            </p>
          ) : (
            <p role="status" className="mt-3 text-sm text-muted-foreground">
              Chargement…
            </p>
          )}
        </section>

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
          >
            <p>{SUPPORT_ERROR_MESSAGES[error.kind]}</p>
            {error.reference && (
              <p className="mt-1">
                Référence :{" "}
                <strong className="font-mono">{error.reference}</strong>
              </p>
            )}
          </div>
        )}

        <Button
          type="submit"
          disabled={sending || !online || !context}
          className="h-11 w-full sm:w-auto"
        >
          {sending ? "Envoi…" : "Envoyer au service client"}
        </Button>
      </form>
    </section>
  );
}
