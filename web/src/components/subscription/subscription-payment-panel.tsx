"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCwIcon, SmartphoneIcon } from "lucide-react";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  SUBSCRIPTION_OFFERS,
  knownTerm,
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
import { createResponseOrder } from "@/lib/refresh-coordinator";
import { useLiveRefresh, useSocketSignals } from "@/hooks/use-live-refresh";
import { OfferConditions, OfferSelector } from "./subscription-offers";
import { rich } from "@/i18n/rich";

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
//
// 1-15F — temps réel (session applicative seulement : le socket du shell ;
// jamais en session limitée ni sur l'écran de blocage, sans socket) :
// - `payments:changed` (payload vide, propriétaire réel seul) → relecture
//   SILENCIEUSE regroupée de l'historique et du paiement affiché, par les
//   seules lectures LOCALES (`GET …/payments`, `GET …/payments/:id`) ;
//   jamais `…/refresh`, donc jamais le prestataire ; rattrapage à la
//   reconnexion ;
// - une relecture ne crée, ne confirme ni ne relance aucun paiement, ne
//   touche ni au marqueur de reprise, ni à l'UUID, ni au verrou
//   d'initiation, et n'appelle jamais `onAccessRestore` ;
// - réponse ignorée si une réponse plus récente a été appliquée, si une
//   action de l'utilisateur a appliqué une réponse pendant la relecture
//   (relecture redemandée), ou pour un paiement qui n'est plus celui affiché ;
// - `succeeded` est définitif : une réponse ancienne ne réaffiche jamais
//   `pending` après `succeeded` (le serveur ne régresse jamais un succès).

const PAYMENT_SIGNALS = ["payments:changed"] as const;
const NO_SIGNALS: readonly string[] = [];

/** Vue la plus avancée : un succès connu n'est jamais remplacé. */
function newerView(
  known: ApiSubscriptionPayment,
  fresh: ApiSubscriptionPayment,
): ApiSubscriptionPayment {
  return known.status === "succeeded" && fresh.status !== "succeeded"
    ? known
    : fresh;
}

/** Fusion de la première page relue dans l'historique affiché (`_id` décroissant). */
function mergeHistory(
  items: ApiSubscriptionPayment[],
  fresh: ApiSubscriptionPayment[],
): ApiSubscriptionPayment[] {
  const byId = new Map(items.map((p) => [p.paymentId, p]));
  for (const payment of fresh) {
    const known = byId.get(payment.paymentId);
    byId.set(payment.paymentId, known ? newerView(known, payment) : payment);
  }
  return [...byId.values()].sort((a, b) =>
    a.paymentId < b.paymentId ? 1 : a.paymentId > b.paymentId ? -1 : 0,
  );
}

// 1-16G : libellés dans `subscription` (`payment.status.*`) ; les messages
// gardés en état sont des CLÉS, traduites à l'affichage (un changement de
// langue les suit sans rien relancer).
type MessageKey =
  | `payment.errors.${PaymentErrorKind["kind"] | "unauthorizedRestricted"}`
  | `payment.messages.${
      | "offlineCreate"
      | "termRequired"
      | "phoneRequired"
      | "replayed"
      | "sent"
      | "confirmed"
      | "offlineVerify"}`;

type Message =
  | { tone: "info" | "error" | "success"; key: MessageKey }
  | {
      tone: "info";
      key: "payment.messages.statusChecked" | "payment.messages.statusNow";
      status: SubscriptionPaymentStatus;
    };

/** Message utile, sans faux succès ni détail technique. */
function messageFor(error: PaymentErrorKind, restricted: boolean): MessageKey {
  switch (error.kind) {
    case "unexpected":
      return "payment.errors.no-response";
    case "unauthorized":
      return restricted
        ? "payment.errors.unauthorizedRestricted"
        : "payment.errors.unauthorized";
    default:
      return `payment.errors.${error.kind}`;
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
  const { t } = useT("subscription");
  const format = useFormat();
  const formatDate = (iso: string | null): string | null => {
    if (!iso) return null;
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? null
      : format.dateWith(date, { dateStyle: "medium", timeStyle: "short" });
  };
  const termText = (value: string | null | undefined) => {
    const term = knownTerm(value);
    return term ? t(`offers.term.${term}`) : "—";
  };
  const restricted = token !== undefined;
  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState<ApiSubscriptionPayment | null>(null);
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [history, setHistory] = useState<ApiSubscriptionPayment[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<
    "historyUnavailable" | "historyMore" | null
  >(null);
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
  // 1-15F : début de la dernière relecture appliquée (rattrapage), ordre
  // des relectures, génération des réponses appliquées par une action ou le
  // chargement initial, paiement affiché et pages d'historique chargées.
  const [loadedAt, setLoadedAt] = useState<number | undefined>(undefined);
  const reloadOrder = useRef(createResponseOrder());
  const actionEpoch = useRef(0);
  const currentRef = useRef<ApiSubscriptionPayment | null>(null);
  const extraPages = useRef(0);
  useEffect(() => {
    currentRef.current = current;
  }, [current]);

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
      setMessage({ tone: "error", key: messageFor(error, restricted) });
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
      actionEpoch.current += 1;
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
    const requestedAt = Date.now();
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
        setHistoryError("historyUnavailable");
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
      actionEpoch.current += 1;
      setLoadedAt(requestedAt);
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

  // 1-15F — relecture silencieuse sur `payments:changed` (lectures locales
  // seulement). Aucune écriture du marqueur, aucun verrou, aucun message.
  const live = !restricted;
  const reloadRef = useRef<() => void>(() => undefined);
  const reloadFromServer = useCallback(async () => {
    const requestedAt = Date.now();
    const ticket = reloadOrder.current.begin();
    const epoch = actionEpoch.current;
    const selected = currentRef.current?.paymentId ?? null;
    let page: { items: ApiSubscriptionPayment[]; nextCursor: string | null };
    let fresh: ApiSubscriptionPayment | null = null;
    try {
      [page, fresh] = await Promise.all([
        listSubscriptionPayments({ limit: PAYMENT_HISTORY_PAGE_SIZE }, token),
        selected
          ? fetchSubscriptionPayment(selected, token)
          : Promise.resolve(null),
      ]);
    } catch {
      return; // affichage conservé ; rattrapage au prochain signal
    }
    if (!mounted.current) return;
    // Une action (ou le chargement initial) a appliqué une réponse pendant
    // la relecture : celle-ci est peut-être plus ancienne → relue ensuite.
    if (actionEpoch.current !== epoch) {
      reloadRef.current();
      return;
    }
    if (!reloadOrder.current.accept(ticket)) return;
    setLoadedAt(requestedAt);
    setHistory((items) => mergeHistory(items, page.items));
    if (extraPages.current === 0) setNextCursor(page.nextCursor);
    setHistoryError(null);
    const open =
      page.items.find((p) => BLOCKING_PAYMENT_STATUSES.has(p.status)) ?? null;
    setCurrent((previous) => {
      let next = previous;
      // Paiement relu par son identifiant : appliqué seulement s'il est
      // toujours celui affiché.
      if (fresh && previous && previous.paymentId === fresh.paymentId) {
        next = newerView(previous, fresh);
      } else if (previous && previous.paymentId !== selected) {
        return previous;
      }
      // Paiement ouvert créé ailleurs (autre onglet, autre appareil) :
      // affiché, ce qui bloque toute nouvelle collecte ici.
      if (
        open &&
        open.paymentId !== next?.paymentId &&
        (next === null || !BLOCKING_PAYMENT_STATUSES.has(next.status))
      ) {
        return open;
      }
      return next;
    });
  }, [token]);
  const requestReload = useLiveRefresh(
    reloadFromServer,
    live ? loadedAt : undefined,
  );
  useEffect(() => {
    reloadRef.current = requestReload;
  }, [requestReload]);
  useSocketSignals(live ? PAYMENT_SIGNALS : NO_SIGNALS, requestReload);

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
      setMessage({ tone: "error", key: "payment.messages.offlineCreate" });
      return;
    }
    if (!selectedTerm) {
      setMessage({ tone: "error", key: "payment.messages.termRequired" });
      return;
    }
    if (phone.trim().length === 0) {
      setMessage({ tone: "error", key: "payment.messages.phoneRequired" });
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
        key: created.replayed
          ? "payment.messages.replayed"
          : "payment.messages.sent",
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
      setMessage({ tone: "error", key: "payment.messages.offlineVerify" });
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
        setMessage({ tone: "success", key: "payment.messages.confirmed" });
        onAccessRestore();
      } else {
        setMessage({
          tone: "info",
          key: "payment.messages.statusChecked",
          status: updated.status,
        });
      }
    } catch (error) {
      if (!mounted.current) return;
      const kind = classifyPaymentError(error);
      if (kind.kind === "not-found") {
        actionEpoch.current += 1;
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
      actionEpoch.current += 1;
      upsertHistory(fresh);
      if (fresh.status !== "failed") {
        track(fresh, intent?.clientOperationId ?? null);
        setMessage({
          tone: "info",
          key: "payment.messages.statusNow",
          status: fresh.status,
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
      extraPages.current += 1;
      setHistoryError(null);
    } catch (error) {
      if (!mounted.current) return;
      setHistoryError("historyMore");
      applyError(classifyPaymentError(error));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  if (loading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t("payment.loading")}
      </p>
    );
  }

  const copy = current
    ? {
        label: t(`payment.status.${current.status}.label`),
        detail: t(`payment.status.${current.status}.detail`),
      }
    : null;
  const messageText = (m: Message) =>
    "status" in m
      ? t(m.key, { status: t(`payment.status.${m.status}.lower`) })
      : t(m.key);

  return (
    <div className="space-y-6" data-testid="subscription-payment-panel">
      {!online && (
        <p
          role="status"
          className="rounded-lg bg-muted p-3 text-sm"
          data-testid="payment-offline"
        >
          {t("payment.offline")}
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
              <dt className="text-muted-foreground">{t("payment.term")}</dt>
              <dd data-testid="payment-term">{termText(current.term)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                {t("payment.totalAmount")}
              </dt>
              <dd className="font-semibold" data-testid="payment-amount">
                {format.fcfa(current.amount)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("payment.payer")}</dt>
              <dd data-testid="payment-phone">{current.payerPhoneMasked}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                {t("payment.reference")}
              </dt>
              <dd className="break-all font-mono text-xs leading-5">
                {current.reference}
              </dd>
            </div>
            {formatDate(current.createdAt) && (
              <div>
                <dt className="text-muted-foreground">
                  {t("payment.requestedOn")}
                </dt>
                <dd>{formatDate(current.createdAt)}</dd>
              </div>
            )}
            {formatDate(current.confirmedAt) && (
              <div>
                <dt className="text-muted-foreground">
                  {t("payment.confirmedOn")}
                </dt>
                <dd>{formatDate(current.confirmedAt)}</dd>
              </div>
            )}
          </dl>
          {current.status === "pending" && (
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <SmartphoneIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {t("payment.pinNotice")}
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
                {busy === "refresh"
                  ? t("payment.checking")
                  : t("payment.verify")}
              </Button>
            )}
            {current.status === "succeeded" && (
              <Button
                type="button"
                className="h-11 px-5"
                disabled={busy !== null}
                onClick={onAccessRestore}
              >
                {restricted ? t("payment.openShop") : t("manager.verify")}
              </Button>
            )}
            {current.status === "failed" && (
              <Button
                type="button"
                className="h-11 px-5"
                disabled={busy !== null || !online}
                onClick={() => void startNewAttempt()}
              >
                {busy === "read"
                  ? t("payment.checking")
                  : t("payment.newAttempt")}
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
          {messageText(message)}
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
          {t("payment.renew")}
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
            {t("payment.formTitle")}
          </h3>
          {lockedTerm ? (
            <p
              className="rounded-lg bg-muted p-3 text-sm"
              data-testid="payment-locked-intent"
            >
              {rich(t("payment.lockedIntent", { term: termText(lockedTerm) }), {
                b: (chunk) => <strong>{chunk}</strong>,
              })}
            </p>
          ) : (
            <>
              <OfferSelector selected={term} onSelect={setTerm} />
              <OfferConditions />
            </>
          )}
          <div className="space-y-2">
            <Label htmlFor="payer-phone">{t("payment.phoneLabel")}</Label>
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
              {t("payment.phoneHelp")}
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
                {rich(
                  t("payment.summary", {
                    amount: format.fcfa(offer.totalXaf),
                    term: t(`offers.term.${offer.term}`),
                  }),
                  { b: (chunk) => <strong>{chunk}</strong> },
                )}
              </p>
            ) : (
              <p>{t("payment.summaryEmpty")}</p>
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
                ? t("payment.sending")
                : offer
                  ? t("payment.payAmount", {
                      amount: format.fcfa(offer.totalXaf),
                    })
                  : t("payment.pay")}
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
                {t("payment.cancel")}
              </Button>
            )}
          </div>
        </form>
      )}

      {message && (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          aria-live={message.tone === "error" ? "assertive" : "polite"}
          data-testid="payment-message"
          className={`text-sm ${message.tone === "error" ? "text-destructive" : ""}`}
        >
          {messageText(message)}
        </p>
      )}

      <section
        aria-labelledby="payment-history-title"
        className="space-y-3"
        data-testid="payment-history"
      >
        <h3 id="payment-history-title" className="font-semibold">
          {t("payment.historyTitle")}
        </h3>
        {historyError && (
          <p role="alert" className="text-sm text-destructive">
            {t(`payment.${historyError}`)}
          </p>
        )}
        {history.length === 0 && !historyError ? (
          <p className="text-sm text-muted-foreground">
            {t("payment.historyEmpty")}
          </p>
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
                    {termText(payment.term)} · {format.fcfa(payment.amount)}
                  </span>
                  <span className="block break-all font-mono text-xs text-muted-foreground">
                    {payment.reference}
                  </span>
                </span>
                <span className="text-xs sm:text-right">
                  <span className="block font-medium">
                    {t(`payment.status.${payment.status}.label`)}
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
            {busy === "history"
              ? t("payment.loadingMore")
              : t("payment.showMore")}
          </Button>
        )}
      </section>
    </div>
  );
}
