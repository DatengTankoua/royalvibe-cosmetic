"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import { getToken } from "@/lib/auth";
import {
  AppNotification,
  MonthlyReportDetails,
  NotificationDetails,
  UnsoldPage,
  fetchReportUnsold,
  openNotification,
} from "@/lib/notifications";

// 1-16G : textes dans `notifications` (`detail.*`), dates selon la langue.
function useDetailFormat() {
  const format = useFormat();
  return {
    ...format,
    dateTime: (v: string | Date) =>
      format.dateWith(v, { dateStyle: "medium", timeStyle: "short" }),
    dateOnly: (v: string | Date) => format.dateWith(v, { dateStyle: "long" }),
    monthName: (v: string | Date) =>
      format.dateWith(v, { month: "long", year: "numeric" }),
  };
}

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
  const { t } = useT("notifications");
  const f = useDetailFormat();
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
        ← {t("title")}
      </Link>
      {state.status === "loading" ? (
        <p className="mt-4 text-sm text-muted-foreground">{t("loading")}</p>
      ) : state.status === "missing" ? (
        <p className="mt-4 text-sm text-muted-foreground">
          {t("detail.missing")}
        </p>
      ) : (
        <article className="mt-4 space-y-4">
          <header>
            <h1 className="text-lg font-semibold">{state.notification.body}</h1>
            <p className="text-xs text-muted-foreground">
              {f.dateTime(state.notification.createdAt)}
            </p>
          </header>
          <Details id={id} details={state.details} />
          {!state.notification.link.startsWith("/app/notifications/") && (
            <Button
              nativeButton={false}
              render={<Link prefetch={false} href={state.notification.link} />}
            >
              {t("detail.open")}
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
  const { t } = useT("notifications");
  const f = useDetailFormat();
  switch (details.kind) {
    case "stock":
      return details.removed ? (
        <p className="text-sm text-muted-foreground">
          {t("detail.productRemoved")}
        </p>
      ) : (
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-muted-foreground">{t("detail.product")}</dt>
          <dd>
            {details.productName}
            {details.inTrash ? ` ${t("detail.inTrash")}` : ""}
          </dd>
          <dt className="text-muted-foreground">
            {t("detail.remainingStock")}
          </dt>
          <dd>
            {details.remainingQuantity} / {details.initialQuantity}
          </dd>
        </dl>
      );
    case "sale":
      return details.cancelled ? (
        <p className="text-sm text-muted-foreground">
          {t("detail.saleCancelled")}
        </p>
      ) : (
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-muted-foreground">{t("detail.product")}</dt>
          <dd>{details.productName ?? "—"}</dd>
          <dt className="text-muted-foreground">{t("detail.quantity")}</dt>
          <dd>{details.quantity}</dd>
          <dt className="text-muted-foreground">{t("detail.amount")}</dt>
          <dd>{f.fcfa(details.total ?? 0)}</dd>
          <dt className="text-muted-foreground">{t("detail.seller")}</dt>
          <dd>{details.sellerName ?? "—"}</dd>
          {details.occurredAt && (
            <>
              <dt className="text-muted-foreground">{t("detail.date")}</dt>
              <dd>{f.dateTime(details.occurredAt)}</dd>
            </>
          )}
        </dl>
      );
    case "subscription-ending":
      return (
        <p className="text-sm">
          {t(details.trial ? "detail.trialEnd" : "detail.subscriptionEnd", {
            date: details.coverageEndsAt
              ? f.dateTime(details.coverageEndsAt)
              : "—",
          })}
        </p>
      );
    case "payment":
      return (
        <p className="text-sm">
          {details.confirmedAt
            ? t("detail.paymentConfirmedOn", {
                date: f.dateTime(details.confirmedAt),
              })
            : t("detail.paymentConfirmed")}
        </p>
      );
    case "monthly-report":
      return details.missing ? (
        <p className="text-sm text-muted-foreground">
          {t("detail.reportUnavailable")}
        </p>
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
  const { t } = useT("notifications");
  const f = useDetailFormat();
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
        {t("report.summary", {
          count: report.salesCount,
          month: f.monthName(report.periodStart),
          from: f.dateOnly(report.periodStart),
          to: f.dateOnly(lastDay),
          timeZone: report.timeZone,
          computedAt: f.dateTime(report.computedAt),
        })}
      </p>

      <section>
        <h2 className="font-semibold">{t("report.topProducts")}</h2>
        {report.topProducts.length === 0 ? (
          <p className="text-muted-foreground">{t("report.noSales")}</p>
        ) : (
          <ol className="mt-1 list-decimal pl-5">
            {report.topProducts.map((p) => (
              <li key={p.productId}>
                {p.name ?? t("report.unknownProduct")}
                {p.deleted ? ` ${t("report.deleted")}` : ""} —{" "}
                {t("report.unitsSold", { count: p.units })}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <h2 className="font-semibold">{t("report.sellerOfMonth")}</h2>
        {report.sellersOfMonth.length === 0 ? (
          <p className="text-muted-foreground">{t("report.noSeller")}</p>
        ) : (
          <ul className="mt-1">
            {report.sellersOfMonth.map((s) => (
              <li key={s.sellerId}>
                {s.name} — {f.fcfa(s.revenue)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="font-semibold">
          {t("report.unsold", { count: unsold.total })}
        </h2>
        {unsold.total === 0 ? (
          <p className="text-muted-foreground">{t("report.allSold")}</p>
        ) : (
          <ul className="mt-1">
            {unsold.items.map((p) => (
              <li key={p.productId}>
                {p.name}
                {p.introducedDuringMonth
                  ? ` — ${t("report.addedDuringMonth")}`
                  : ""}
                {p.inTrash ? ` ${t("detail.inTrash")}` : ""}
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
            {t("showMore")}
          </Button>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          {t("report.purgedNote")}
        </p>
      </section>
    </div>
  );
}
