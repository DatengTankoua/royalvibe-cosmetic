"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getToken } from "@/lib/auth";
import { fmtXof } from "@/lib/currency";
import {
  AppNotification,
  MonthlyReportDetails,
  NotificationDetails,
  UnsoldPage,
  fetchReportUnsold,
  openNotification,
} from "@/lib/notifications";

const dateTime = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "medium",
  timeStyle: "short",
});
const dateOnly = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" });
const monthName = new Intl.DateTimeFormat("fr-FR", {
  month: "long",
  year: "numeric",
});

type State =
  | { status: "loading" }
  | { status: "missing" }
  | {
      status: "ready";
      notification: AppNotification;
      details: NotificationDetails;
    };

// Détail d'une notification (1-16A.1). L'ouverture est une consultation
// EXPLICITE : le serveur fixe `readAt` à la première ouverture seulement et
// relit les détails avec les droits actuels (404 si la catégorie n'est plus
// autorisée : rien n'est affiché).
export default function NotificationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    const token = getToken();
    let cancelled = false;
    openNotification(id)
      .then((result) => {
        if (cancelled || getToken() !== token) return;
        setState({ status: "ready", ...result });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "missing" });
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-6 sm:px-6">
      <Link
        prefetch={false}
        href="/app/notifications"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← Notifications
      </Link>
      {state.status === "loading" ? (
        <p className="mt-4 text-sm text-muted-foreground">Chargement…</p>
      ) : state.status === "missing" ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Notification introuvable ou plus disponible.
        </p>
      ) : (
        <article className="mt-4 space-y-4">
          <header>
            <h1 className="text-lg font-semibold">{state.notification.body}</h1>
            <p className="text-xs text-muted-foreground">
              {dateTime.format(new Date(state.notification.createdAt))}
            </p>
          </header>
          <Details id={id} details={state.details} />
          {!state.notification.link.startsWith("/app/notifications/") && (
            <Button
              nativeButton={false}
              render={<Link prefetch={false} href={state.notification.link} />}
            >
              Ouvrir
            </Button>
          )}
        </article>
      )}
    </div>
  );
}

function Details({
  id,
  details,
}: {
  id: string;
  details: NotificationDetails;
}) {
  switch (details.kind) {
    case "stock":
      return details.removed ? (
        <p className="text-sm text-muted-foreground">
          Ce produit a été supprimé définitivement.
        </p>
      ) : (
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-muted-foreground">Produit</dt>
          <dd>
            {details.productName}
            {details.inTrash ? " (corbeille)" : ""}
          </dd>
          <dt className="text-muted-foreground">Stock restant</dt>
          <dd>
            {details.remainingQuantity} / {details.initialQuantity}
          </dd>
        </dl>
      );
    case "sale":
      return details.cancelled ? (
        <p className="text-sm text-muted-foreground">
          Cette vente a été annulée depuis.
        </p>
      ) : (
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-muted-foreground">Produit</dt>
          <dd>{details.productName ?? "—"}</dd>
          <dt className="text-muted-foreground">Quantité</dt>
          <dd>{details.quantity}</dd>
          <dt className="text-muted-foreground">Montant</dt>
          <dd>{fmtXof(details.total ?? 0)}</dd>
          <dt className="text-muted-foreground">Vendeur</dt>
          <dd>{details.sellerName ?? "—"}</dd>
          {details.occurredAt && (
            <>
              <dt className="text-muted-foreground">Date</dt>
              <dd>{dateTime.format(new Date(details.occurredAt))}</dd>
            </>
          )}
        </dl>
      );
    case "subscription-ending":
      return (
        <p className="text-sm">
          {details.trial ? "Fin de l'essai" : "Fin de l'abonnement"} :{" "}
          {details.coverageEndsAt
            ? dateTime.format(new Date(details.coverageEndsAt))
            : "—"}
        </p>
      );
    case "payment":
      return (
        <p className="text-sm">
          Paiement confirmé
          {details.confirmedAt
            ? ` le ${dateTime.format(new Date(details.confirmedAt))}`
            : ""}
          .
        </p>
      );
    case "monthly-report":
      return details.missing ? (
        <p className="text-sm text-muted-foreground">Bilan indisponible.</p>
      ) : (
        <MonthlyReport id={id} report={details as MonthlyReportDetails} />
      );
  }
}

function MonthlyReport({
  id,
  report,
}: {
  id: string;
  report: MonthlyReportDetails;
}) {
  const [unsold, setUnsold] = useState<UnsoldPage>(report.unsold);
  const [loading, setLoading] = useState(false);
  const lastDay = new Date(new Date(report.periodEnd).getTime() - 1);

  const more = async () => {
    setLoading(true);
    try {
      const page = await fetchReportUnsold(id, unsold.items.length);
      setUnsold({ ...page, items: [...unsold.items, ...page.items] });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-5 text-sm">
      <p className="text-muted-foreground">
        Bilan de {monthName.format(new Date(report.periodStart))} (du{" "}
        {dateOnly.format(new Date(report.periodStart))} au{" "}
        {dateOnly.format(lastDay)}, fuseau {report.timeZone}) — calculé le{" "}
        {dateTime.format(new Date(report.computedAt))}. {report.salesCount}{" "}
        vente{report.salesCount > 1 ? "s" : ""}.
      </p>

      <section>
        <h2 className="font-semibold">Produits les plus vendus</h2>
        {report.topProducts.length === 0 ? (
          <p className="text-muted-foreground">Aucune vente ce mois-ci.</p>
        ) : (
          <ol className="mt-1 list-decimal pl-5">
            {report.topProducts.map((p) => (
              <li key={p.productId}>
                {p.name ?? "Produit inconnu"}
                {p.deleted ? " (supprimé)" : ""} — {p.units} vendu
                {p.units > 1 ? "s" : ""}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <h2 className="font-semibold">Vendeur du mois</h2>
        {report.sellersOfMonth.length === 0 ? (
          <p className="text-muted-foreground">
            Aucun vendeur du mois n&apos;est désigné (aucune vente).
          </p>
        ) : (
          <ul className="mt-1">
            {report.sellersOfMonth.map((s) => (
              <li key={s.sellerId}>
                {s.name} — {fmtXof(s.revenue)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="font-semibold">Produits sans vente ({unsold.total})</h2>
        {unsold.total === 0 ? (
          <p className="text-muted-foreground">
            Tous les produits ont été vendus.
          </p>
        ) : (
          <ul className="mt-1">
            {unsold.items.map((p) => (
              <li key={p.productId}>
                {p.name}
                {p.introducedDuringMonth ? " — ajouté pendant le mois" : ""}
                {p.inTrash ? " (corbeille)" : ""}
              </li>
            ))}
          </ul>
        )}
        {unsold.items.length < unsold.total && (
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void more()}
            disabled={loading}
          >
            Afficher plus
          </Button>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Produits supprimés définitivement sans vente pendant le mois : non
          listés (aucune trace conservée).
        </p>
      </section>
    </div>
  );
}
