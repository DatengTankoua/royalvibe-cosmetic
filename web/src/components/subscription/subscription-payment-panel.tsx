"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCwIcon, SmartphoneIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  SUBSCRIPTION_OFFERS,
  formatFcfa,
  termLabel,
  type SubscriptionTerm,
} from "@/lib/subscription-offers";
import {
  BLOCKING_PAYMENT_STATUSES,
  PAYMENT_HISTORY_PAGE_SIZE,
  classifyPaymentError,
  createSubscriptionPayment,
  fetchSubscriptionPayment,
  isDefinitiveCreationRefusal,
  listSubscriptionPayments,
  newClientOperationId,
  refreshSubscriptionPayment,
  type ApiSubscriptionPayment,
  type PaymentErrorKind,
  type SubscriptionPaymentStatus,
} from "@/lib/subscription-payments";
import {
  clearPaymentIntent,
  readPaymentIntent,
  writePaymentIntent,
  type PaymentIdentity,
  type PaymentIntent,
} from "@/lib/payment-intent";
import { OfferConditions, OfferSelector } from "./subscription-offers";

// 1-14D.2C — Paiement Mobile Money de l'abonnement par le PROPRIÉTAIRE réel.
//
// Garanties côté navigateur (le serveur reste l'autorité) :
// - UNE intention = UN `clientOperationId` (UUID v4), écrit dans le
//   marqueur AVANT l'envoi et rejoué tel quel après une réponse perdue ;
//   jamais régénéré automatiquement, jamais de relance automatique du POST ;
// - aucune nouvelle collecte tant qu'un paiement est `initiating`,
//   `pending`, `uncertain` ou `review` ; nouvel essai après `failed`
//   uniquement sur action explicite ET relecture serveur récente ;
// - aucun polling, aucune vérification au focus : « Vérifier le paiement »
//   est la seule consultation du prestataire ;
// - aucun délai local ne transforme un paiement en échec ;
// - `succeeded` → reprise via `onAccessRestore` (échange `complete`
//   existant), jamais un raccourci d'authentification.

const STATUS_COPY: Record<
  SubscriptionPaymentStatus,
  { label: string; detail: string }
> = {
  initiating: {
    label: "Demande en cours",
    detail:
      "La demande de paiement est en cours de transmission à l'opérateur.",
  },
  pending: {
    label: "En attente de paiement",
    detail:
      "Validez le paiement sur le téléphone du payeur, puis appuyez sur « Vérifier le paiement ».",
  },
  uncertain: {
    label: "Résultat à vérifier",
    detail:
      "La transmission n'a pas pu être confirmée. Vérifiez ce paiement : aucune nouvelle demande ne sera envoyée.",
  },
  review: {
    label: "Vérification nécessaire",
    detail:
      "Ce paiement doit être vérifié par notre équipe. Aucune nouvelle demande n'est possible en attendant.",
  },
  failed: {
    label: "Échec confirmé",
    detail: "L'opérateur a confirmé que ce paiement n'a pas abouti.",
  },
  succeeded: {
    label: "Paiement confirmé",
    detail: "Le paiement est confirmé et l'abonnement a été prolongé.",
  },
};

type Message = { tone: "info" | "error" | "success"; text: string };

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? null
    : new Intl.DateTimeFormat("fr-FR", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

/** Message utile, sans faux succès ni détail technique. */
function messageFor(error: PaymentErrorKind, restricted: boolean): string {
  switch (error.kind) {
    case "no-response":
    case "unexpected":
      return "Réponse non reçue. Rien n'est perdu : vérifiez votre connexion puis réessayez.";
    case "unauthorized":
      return restricted
        ? "Votre session a expiré. Reconnectez-vous : votre paiement sera retrouvé."
        : "Votre session a expiré. Reconnectez-vous.";
    case "forbidden":
      return "Accès refusé pour ce commerce.";
    case "already-pending":
      return "Un paiement est déjà en cours pour ce commerce.";
    case "operation-conflict":
      return "Cette demande a déjà été envoyée avec d'autres informations. Saisissez exactement le même numéro.";
    case "invalid-phone":
      return "Numéro Mobile Money camerounais invalide (ex. 6XX XX XX XX).";
    case "invalid-request":
      return "Demande invalide. Vérifiez les informations saisies.";
    case "not-found":
      return "Paiement introuvable pour ce commerce.";
    case "rate-limited":
      return "Trop de demandes. Patientez avant de réessayer.";
    case "service-unavailable":
      return "Le paiement en ligne est indisponible pour le moment. Réessayez plus tard.";
    case "status-unavailable":
      return "Impossible de vérifier ce paiement pour le moment. Réessayez plus tard.";
    case "confirmation-pending":
      return "Paiement en cours de confirmation. Vérifiez de nouveau dans un instant.";
  }
}

export function SubscriptionPaymentPanel({
  identity,
  token,
  onAccessRestore,
}: {
  /** Identité VÉRIFIÉE par le serveur (contexte), portée du marqueur. */
  identity: PaymentIdentity;
  /** Jeton limité explicite ; absent = JWT applicatif courant. */
  token?: string;
  /** Reprise commerciale existante (contexte + échange `complete`). */
  onAccessRestore: () => void;
}) {
  const restricted = token !== undefined;
  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState<ApiSubscriptionPayment | null>(null);
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [history, setHistory] = useState<ApiSubscriptionPayment[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [busy, setBusy] = useState<
    "create" | "refresh" | "read" | "history" | null
  >(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [term, setTerm] = useState<SubscriptionTerm | null>(null);
  const [phone, setPhone] = useState("");
  const [online, setOnline] = useState(true);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  // Verrou SYNCHRONE contre le double clic (l'état React est asynchrone).
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setOnline(typeof navigator === "undefined" || navigator.onLine);
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // Réactivation après `Retry-After` : un minuteur LOCAL, aucun appel réseau.
  useEffect(() => {
    if (retryAt === null) return;
    const delay = Math.max(0, retryAt - Date.now());
    const timer = window.setTimeout(() => setRetryAt(null), delay);
    return () => window.clearTimeout(timer);
  }, [retryAt]);

  const applyError = useCallback(
    (error: PaymentErrorKind) => {
      if (error.kind === "rate-limited") {
        setRetryAt(Date.now() + (error.retryAfterMs ?? 60_000));
      }
      setMessage({ tone: "error", text: messageFor(error, restricted) });
    },
    [restricted],
  );

  const upsertHistory = useCallback((payment: ApiSubscriptionPayment) => {
    setHistory((items) => {
      const index = items.findIndex((p) => p.paymentId === payment.paymentId);
      if (index === -1) return [payment, ...items];
      const copy = [...items];
      copy[index] = payment;
      return copy;
    });
  }, []);

  /** Le paiement affiché devient la référence de reprise de l'identité. */
  const track = useCallback(
    (payment: ApiSubscriptionPayment, clientOperationId: string | null) => {
      setCurrent(payment);
      upsertHistory(payment);
      if (payment.status === "succeeded") {
        clearPaymentIntent(identity);
        setIntent(null);
        return;
      }
      const next: PaymentIntent = {
        ...identity,
        clientOperationId,
        term: payment.term,
        paymentId: payment.paymentId,
        savedAt: Date.now(),
      };
      writePaymentIntent(next);
      setIntent(next);
    },
    [identity, upsertHistory],
  );

  // Chargement : marqueur local (non fiable) + lectures serveur LOCALES
  // (historique, paiement connu). Aucun appel au prestataire.
  useEffect(() => {
    let cancelled = false;
    const stored = readPaymentIntent(identity);
    setIntent(stored);
    setLoading(true);
    void (async () => {
      let page: { items: ApiSubscriptionPayment[]; nextCursor: string | null } =
        { items: [], nextCursor: null };
      try {
        page = await listSubscriptionPayments(
          { limit: PAYMENT_HISTORY_PAGE_SIZE },
          token,
        );
      } catch (error) {
        if (cancelled) return;
        // Historique indisponible : la reprise continue avec le marqueur
        // (paiement connu relu, ou intention sans réponse proposée au rejeu).
        setHistoryError("Historique des paiements indisponible.");
        applyError(classifyPaymentError(error));
      }
      if (cancelled) return;
      setHistory(page.items);
      setNextCursor(page.nextCursor);
      let found: ApiSubscriptionPayment | null = null;
      if (stored?.paymentId) {
        try {
          found = await fetchSubscriptionPayment(stored.paymentId, token);
        } catch (error) {
          if (cancelled) return;
          if (classifyPaymentError(error).kind === "not-found") {
            clearPaymentIntent(identity);
            setIntent(null);
          }
        }
      }
      // Paiement ouvert retrouvé côté serveur (réauthentification, autre
      // appareil, marqueur effacé) : le plus récent, unique par commerce.
      if (!found) {
        const open = page.items.find((p) =>
          BLOCKING_PAYMENT_STATUSES.has(p.status),
        );
        if (open) found = open;
      }
      if (cancelled) return;
      if (found) {
        setCurrent(found);
        if (found.status === "succeeded") {
          clearPaymentIntent(identity);
          setIntent(null);
        } else if (stored?.paymentId !== found.paymentId) {
          // Paiement ouvert retrouvé (éventuellement celui d'une réponse
          // perdue) : il devient la référence de reprise ; l'UUID local n'est
          // plus nécessaire (un seul paiement ouvert par commerce).
          const next: PaymentIntent = {
            ...identity,
            clientOperationId: null,
            term: found.term,
            paymentId: found.paymentId,
            savedAt: Date.now(),
          };
          writePaymentIntent(next);
          setIntent(next);
        }
      } else if (stored && stored.paymentId === null) {
        // Réponse perdue : MÊME UUID, MÊME durée ; nouvelle saisie du numéro.
        setTerm(stored.term);
        setFormOpen(true);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // `identity` et `token` définissent le contexte ; le panneau est
    // remonté (clé) à chaque changement d'identité.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity.userId, identity.organizationId, token]);

  const lostIntent = intent !== null && intent.paymentId === null;
  const lockedTerm = lostIntent ? intent.term : null;
  const blocking =
    current !== null && BLOCKING_PAYMENT_STATUSES.has(current.status);
  const rateLimited = retryAt !== null;
  const selectedTerm = lockedTerm ?? term;
  const offer = SUBSCRIPTION_OFFERS.find((o) => o.term === selectedTerm);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current || blocking || rateLimited) return;
    if (!online) {
      setMessage({
        tone: "error",
        text: "Hors connexion : la création d'un paiement nécessite Internet.",
      });
      return;
    }
    if (!selectedTerm) {
      setMessage({ tone: "error", text: "Choisissez une durée." });
      return;
    }
    if (phone.trim().length === 0) {
      setMessage({
        tone: "error",
        text: "Saisissez le numéro Mobile Money du payeur.",
      });
      return;
    }
    inFlight.current = true;
    setBusy("create");
    setMessage(null);
    // Intention écrite AVANT l'envoi : une réponse perdue rejouera le MÊME
    // UUID et la MÊME durée.
    const replaying = lostIntent && intent !== null;
    const active: PaymentIntent =
      replaying && intent
        ? intent
        : {
            ...identity,
            clientOperationId: newClientOperationId(),
            term: selectedTerm,
            paymentId: null,
            savedAt: Date.now(),
          };
    writePaymentIntent(active);
    setIntent(active);
    try {
      const created = await createSubscriptionPayment(
        {
          term: active.term,
          payerPhone: phone,
          clientOperationId: active.clientOperationId as string,
        },
        token,
      );
      if (!mounted.current) return;
      setPhone("");
      setFormOpen(false);
      track(created, active.clientOperationId);
      setMessage({
        tone: "info",
        text: created.replayed
          ? "Demande retrouvée : aucun nouveau paiement n'a été demandé."
          : "Demande envoyée. L'abonnement sera actif une fois le paiement confirmé.",
      });
    } catch (error) {
      if (!mounted.current) return;
      const kind = classifyPaymentError(error);
      if (kind.kind === "already-pending") {
        // Autre onglet/appareil : CET UUID n'a rien créé. On affiche le
        // paiement ouvert indiqué par le serveur, sans nouvelle collecte.
        clearPaymentIntent(identity);
        setIntent(null);
        setPhone("");
        setFormOpen(false);
        if (kind.paymentId) {
          try {
            const existing = await fetchSubscriptionPayment(
              kind.paymentId,
              token,
            );
            if (mounted.current) track(existing, null);
          } catch (readError) {
            if (mounted.current) applyError(classifyPaymentError(readError));
          }
        }
      } else if (isDefinitiveCreationRefusal(kind) && !replaying) {
        // Refus DÉFINITIF d'une intention NOUVELLE : rien n'a été créé avec
        // cet UUID ; il est abandonné (la durée reste modifiable).
        clearPaymentIntent(identity);
        setIntent(null);
      }
      // Sinon (issue inconnue, conflit, indisponibilité, limitation, ou
      // intention rejouée) : l'intention reste verrouillée (UUID + durée).
      applyError(kind);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  const verify = async () => {
    if (!current || inFlight.current || rateLimited) return;
    if (!online) {
      setMessage({
        tone: "error",
        text: "Hors connexion : la vérification nécessite Internet.",
      });
      return;
    }
    inFlight.current = true;
    setBusy("refresh");
    setMessage(null);
    try {
      const updated = await refreshSubscriptionPayment(
        current.paymentId,
        token,
      );
      if (!mounted.current) return;
      track(updated, intent?.clientOperationId ?? null);
      if (updated.status === "succeeded") {
        setMessage({
          tone: "success",
          text: "Paiement confirmé. Rétablissement de l'accès…",
        });
        onAccessRestore();
      } else {
        setMessage({
          tone: "info",
          text: `Statut vérifié : ${STATUS_COPY[updated.status].label.toLowerCase()}.`,
        });
      }
    } catch (error) {
      if (!mounted.current) return;
      const kind = classifyPaymentError(error);
      if (kind.kind === "not-found") {
        clearPaymentIntent(identity);
        setIntent(null);
        setCurrent(null);
      }
      applyError(kind);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  /** Nouvel essai après `failed` : action explicite + relecture serveur. */
  const startNewAttempt = async () => {
    if (!current || inFlight.current) return;
    inFlight.current = true;
    setBusy("read");
    setMessage(null);
    try {
      const fresh = await fetchSubscriptionPayment(current.paymentId, token);
      if (!mounted.current) return;
      upsertHistory(fresh);
      if (fresh.status !== "failed") {
        track(fresh, intent?.clientOperationId ?? null);
        setMessage({
          tone: "info",
          text: `Ce paiement est désormais : ${STATUS_COPY[fresh.status].label.toLowerCase()}.`,
        });
        return;
      }
      clearPaymentIntent(identity);
      setIntent(null);
      setCurrent(null);
      setTerm(null);
      setPhone("");
      setFormOpen(true);
    } catch (error) {
      if (mounted.current) applyError(classifyPaymentError(error));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  const loadMore = async () => {
    if (!nextCursor || inFlight.current) return;
    inFlight.current = true;
    setBusy("history");
    try {
      const page = await listSubscriptionPayments(
        { limit: PAYMENT_HISTORY_PAGE_SIZE, before: nextCursor },
        token,
      );
      if (!mounted.current) return;
      setHistory((items) => [
        ...items,
        ...page.items.filter(
          (p) => !items.some((i) => i.paymentId === p.paymentId),
        ),
      ]);
      setNextCursor(page.nextCursor);
      setHistoryError(null);
    } catch (error) {
      if (!mounted.current) return;
      setHistoryError("Impossible de charger plus de paiements.");
      applyError(classifyPaymentError(error));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  if (loading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Chargement des paiements…
      </p>
    );
  }

  const copy = current ? STATUS_COPY[current.status] : null;

  return (
    <div className="space-y-6" data-testid="subscription-payment-panel">
      {!online && (
        <p
          role="status"
          className="rounded-lg bg-muted p-3 text-sm"
          data-testid="payment-offline"
        >
          Hors connexion : la création et la vérification d&apos;un paiement
          nécessitent Internet.
        </p>
      )}

      {current && copy && (
        <section
          aria-labelledby="current-payment-title"
          className="space-y-3 rounded-xl border p-4"
          data-testid="current-payment"
          data-status={current.status}
        >
          <div role="status" aria-live="polite" className="space-y-1">
            <h3 id="current-payment-title" className="font-semibold">
              {copy.label}
            </h3>
            <p className="text-sm text-muted-foreground">{copy.detail}</p>
          </div>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Durée</dt>
              <dd data-testid="payment-term">{termLabel(current.term)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Montant total</dt>
              <dd className="font-semibold" data-testid="payment-amount">
                {formatFcfa(current.amount)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Payeur</dt>
              <dd data-testid="payment-phone">{current.payerPhoneMasked}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Référence</dt>
              <dd className="break-all font-mono text-xs leading-5">
                {current.reference}
              </dd>
            </div>
            {formatDate(current.createdAt) && (
              <div>
                <dt className="text-muted-foreground">Demandé le</dt>
                <dd>{formatDate(current.createdAt)}</dd>
              </div>
            )}
            {formatDate(current.confirmedAt) && (
              <div>
                <dt className="text-muted-foreground">Confirmé le</dt>
                <dd>{formatDate(current.confirmedAt)}</dd>
              </div>
            )}
          </dl>
          {current.status === "pending" && (
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <SmartphoneIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              Le code secret Mobile Money se saisit uniquement sur le téléphone
              du payeur. Stock Master ne le demande jamais.
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            {current.status !== "succeeded" && current.status !== "failed" && (
              <Button
                type="button"
                className="h-11 px-5"
                disabled={busy !== null || rateLimited || !online}
                onClick={() => void verify()}
              >
                <RefreshCwIcon
                  className={`h-4 w-4 ${busy === "refresh" ? "animate-spin" : ""}`}
                  aria-hidden
                />
                {busy === "refresh" ? "Vérification…" : "Vérifier le paiement"}
              </Button>
            )}
            {current.status === "succeeded" && (
              <Button
                type="button"
                className="h-11 px-5"
                disabled={busy !== null}
                onClick={onAccessRestore}
              >
                {restricted
                  ? "Accéder à mon commerce"
                  : "Vérifier mon abonnement"}
              </Button>
            )}
            {current.status === "failed" && (
              <Button
                type="button"
                className="h-11 px-5"
                disabled={busy !== null || !online}
                onClick={() => void startNewAttempt()}
              >
                {busy === "read" ? "Vérification…" : "Nouvel essai"}
              </Button>
            )}
          </div>
        </section>
      )}

      {message && (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          aria-live={message.tone === "error" ? "assertive" : "polite"}
          data-testid="payment-message"
          className={`text-sm ${message.tone === "error" ? "text-destructive" : ""}`}
        >
          {message.text}
        </p>
      )}

      {!blocking && current?.status !== "failed" && !formOpen && (
        <Button
          type="button"
          className="h-11 px-5"
          aria-expanded={formOpen}
          aria-controls="subscription-payment-form"
          onClick={() => {
            setFormOpen(true);
            setMessage(null);
          }}
        >
          Renouveler
        </Button>
      )}

      {!blocking && formOpen && (
        <form
          id="subscription-payment-form"
          aria-labelledby="subscription-payment-form-title"
          className="space-y-4 rounded-xl border p-4"
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          <h3 id="subscription-payment-form-title" className="font-semibold">
            Payer par Mobile Money
          </h3>
          {lockedTerm ? (
            <p
              className="rounded-lg bg-muted p-3 text-sm"
              data-testid="payment-locked-intent"
            >
              Une demande précédente n&apos;a pas reçu de réponse. Saisissez de
              nouveau <strong>le même numéro</strong> pour la retrouver : aucun
              second paiement ne sera demandé. Durée :{" "}
              <strong>{termLabel(lockedTerm)}</strong>.
            </p>
          ) : (
            <>
              <OfferSelector selected={term} onSelect={setTerm} />
              <OfferConditions />
            </>
          )}
          <div className="space-y-2">
            <Label htmlFor="payer-phone">Numéro Mobile Money du payeur</Label>
            <Input
              id="payer-phone"
              name="payerPhone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="6XX XX XX XX"
              maxLength={32}
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              aria-describedby="payer-phone-help"
              className="h-11"
            />
            <p id="payer-phone-help" className="text-xs text-muted-foreground">
              MTN Mobile Money ou Orange Money (Cameroun). Le payeur validera
              sur son téléphone ; aucun code secret n&apos;est demandé ici.
            </p>
          </div>
          <div
            role="status"
            aria-live="polite"
            className="rounded-lg bg-muted p-3 text-sm"
            data-testid="payment-summary"
          >
            {offer ? (
              <p>
                Montant total : <strong>{formatFcfa(offer.totalXaf)}</strong>{" "}
                pour <strong>{offer.label}</strong>. L&apos;abonnement sera
                prolongé une fois le paiement confirmé.
              </p>
            ) : (
              <p>Sélectionnez une durée pour voir le montant total.</p>
            )}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="submit"
              className="h-11 px-5"
              disabled={busy !== null || rateLimited || !online || !offer}
              data-testid="payment-submit"
            >
              {busy === "create"
                ? "Envoi…"
                : offer
                  ? `Payer ${formatFcfa(offer.totalXaf)}`
                  : "Payer"}
            </Button>
            {!lockedTerm && (
              <Button
                type="button"
                variant="ghost"
                className="h-11 px-4"
                disabled={busy === "create"}
                onClick={() => {
                  setFormOpen(false);
                  setPhone("");
                  setMessage(null);
                }}
              >
                Annuler
              </Button>
            )}
          </div>
        </form>
      )}

      <section
        aria-labelledby="payment-history-title"
        className="space-y-3"
        data-testid="payment-history"
      >
        <h3 id="payment-history-title" className="font-semibold">
          Historique des paiements
        </h3>
        {historyError && (
          <p role="alert" className="text-sm text-destructive">
            {historyError}
          </p>
        )}
        {history.length === 0 && !historyError ? (
          <p className="text-sm text-muted-foreground">Aucun paiement.</p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {history.map((payment) => (
              <li
                key={payment.paymentId}
                className="flex flex-col gap-1 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                data-testid="payment-history-item"
                data-status={payment.status}
              >
                <span className="min-w-0">
                  <span className="font-medium">
                    {termLabel(payment.term)} · {formatFcfa(payment.amount)}
                  </span>
                  <span className="block break-all font-mono text-xs text-muted-foreground">
                    {payment.reference}
                  </span>
                </span>
                <span className="text-xs sm:text-right">
                  <span className="block font-medium">
                    {STATUS_COPY[payment.status].label}
                  </span>
                  <span className="text-muted-foreground">
                    {formatDate(payment.confirmedAt ?? payment.createdAt)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {nextCursor && (
          <Button
            type="button"
            variant="outline"
            className="h-11 px-5"
            disabled={busy !== null}
            onClick={() => void loadMore()}
          >
            {busy === "history" ? "Chargement…" : "Afficher plus"}
          </Button>
        )}
      </section>
    </div>
  );
}
