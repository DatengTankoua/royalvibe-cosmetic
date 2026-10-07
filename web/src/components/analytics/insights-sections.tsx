"use client";

import { useState } from "react";
import Link from "next/link";
import {
  AlertTriangleIcon,
  ArrowDownRightIcon,
  ArrowUpRightIcon,
  ClockIcon,
  MinusIcon,
  PackageXIcon,
  PauseCircleIcon,
  TagIcon,
} from "lucide-react";
import type {
  AnalyticsInsights,
  InsightPriceItem,
  InsightPriorityKind,
  InsightStockItem,
  InsightTotals,
} from "@/lib/api";
import { fetchInsightList, getApiErrorMessage } from "@/lib/api";
import { useAnalytics, type AnalyticsFormat } from "./use-analytics";

// 1-16E — sections de la page Analyse. Aucun calcul de décision ici : les
// listes, seuils et estimations viennent du serveur (valeurs non arrondies) ;
// ce module n'arrondit que pour l'affichage.
// 1-16G : textes dans le namespace `analytics`, formats selon la langue.

// 1-15D : un chiffre inconnu s'affiche « — », jamais 0.
export const UNKNOWN = "—";

export const FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-(--tenant-accent-ring) focus-visible:ring-offset-2";
const SECTION_TITLE = "text-lg font-semibold";
const ACTION_PRIMARY = `${FOCUS} inline-flex min-h-10 items-center rounded-lg bg-(--tenant-accent) px-3 text-sm font-medium text-(--tenant-accent-foreground) hover:ring-2 hover:ring-(--tenant-accent-border)`;
const ACTION_SECONDARY = `${FOCUS} inline-flex min-h-10 items-center rounded-lg border border-(--tenant-accent-border) px-3 text-sm font-medium text-(--tenant-accent-ink) hover:bg-(--tenant-accent-soft)`;

/** Dernier jour inclus d'un intervalle `[start, end[`. */
function lastIncludedDay(end: string): Date {
  return new Date(new Date(end).getTime() - 1);
}

export interface ProductActionRights {
  /** `stock.adjust` : stock et prix (même règle que le serveur). */
  canAdjustStock: boolean;
}

const KIND_ICON: Record<InsightPriorityKind, typeof PackageXIcon> = {
  out: PackageXIcon,
  soon: ClockIcon,
  price: TagIcon,
  low: AlertTriangleIcon,
  stale: PauseCircleIcon,
};
// Couleurs d'état réservées, toujours accompagnées d'une icône et d'un titre.
const KIND_TONE: Record<InsightPriorityKind, string> = {
  out: "text-red-700 dark:text-red-400",
  soon: "text-amber-700 dark:text-amber-400",
  price: "text-amber-700 dark:text-amber-400",
  low: "text-amber-700 dark:text-amber-400",
  stale: "text-muted-foreground",
};

function productHref(item: { productId: string }) {
  return `/app/catalog/products/${item.productId}`;
}

/** Parcours existant : fenêtre de modification du produit dans son catalogue. */
function editHref(item: { productId: string; sectionId: string }) {
  return `/app/catalog/${item.sectionId}?modifier=${item.productId}`;
}

function remainingText(a: AnalyticsFormat, quantity: number): string {
  return a.t("stock.remaining", { n: a.number(quantity) });
}

function stockFact(
  a: AnalyticsFormat,
  item: InsightStockItem,
  kind: InsightPriorityKind,
): string {
  const e = item.estimate;
  const base = a.t("watch.stockFact", {
    name: item.name,
    remaining: remainingText(a, item.remainingQuantity),
  });
  if (kind === "soon" && e.estimable && e.daysLeft !== null) {
    return `${base}, ${a.t("stock.daysLeft", { days: a.formatDays(e.daysLeft) })}`;
  }
  return base;
}

type Priority = AnalyticsInsights["priorities"][number];

function PriorityCard({
  priority,
  insights,
  rights,
  onSeeAll,
}: {
  priority: Priority;
  insights: AnalyticsInsights;
  rights: ProductActionRights;
  onSeeAll: (kind: InsightPriorityKind) => void;
}) {
  const a = useAnalytics();
  const { t } = a;
  const Icon = KIND_ICON[priority.kind];
  const thresholds = insights.thresholds;
  const first = priority.items[0];
  const fact =
    priority.kind === "price"
      ? t("watch.priceFact", {
          name: (first as InsightPriceItem).name,
          gain: a.fcfa((first as InsightPriceItem).gain),
        })
      : stockFact(a, first as InsightStockItem, priority.kind);
  const reason =
    priority.kind === "soon"
      ? t("watch.kinds.soon.reason", { days: thresholds.soonStockoutDays })
      : priority.kind === "stale"
        ? t("watch.kinds.stale.reason", {
            days: thresholds.observationWindowDays,
          })
        : t(`watch.kinds.${priority.kind}.reason`);
  const action =
    rights.canAdjustStock && priority.kind !== "stale"
      ? {
          href: editHref(first),
          label:
            priority.kind === "price"
              ? t("watch.actions.reviewPrice")
              : t("watch.actions.restock"),
        }
      : { href: productHref(first), label: t("watch.actions.viewProduct") };
  const others = priority.count - 1;
  const titleId = `priority-${priority.kind}`;
  return (
    <article
      aria-labelledby={titleId}
      className="flex flex-col gap-2 rounded-2xl border bg-card p-4"
    >
      <div className="flex items-center gap-2">
        <Icon
          aria-hidden
          className={`size-5 shrink-0 ${KIND_TONE[priority.kind]}`}
        />
        <h3 id={titleId} className="font-semibold">
          {t(`watch.kinds.${priority.kind}.title`)}
        </h3>
      </div>
      <p className="text-sm text-muted-foreground">
        {t(`watch.kinds.${priority.kind}.count`, {
          count: priority.count,
          n: a.number(priority.count),
        })}
      </p>
      <p className="text-sm font-medium wrap-break-word">
        {fact}{" "}
        <span className="font-normal text-muted-foreground">
          {others > 0
            ? t("watch.andOthers", { count: others, n: a.number(others) })
            : ""}
        </span>
      </p>
      <p className="text-xs text-muted-foreground">{reason}</p>
      <div className="mt-auto flex flex-wrap gap-2 pt-2">
        <Link prefetch={false} href={action.href} className={ACTION_PRIMARY}>
          {action.label}
        </Link>
        {priority.count > 1 && (
          <button
            type="button"
            onClick={() => onSeeAll(priority.kind)}
            className={ACTION_SECONDARY}
          >
            {t("watch.seeAll", { count: priority.count })}
          </button>
        )}
      </div>
    </article>
  );
}

export function WatchSection({
  insights,
  rights,
  onSeeAll,
}: {
  insights: AnalyticsInsights;
  rights: ProductActionRights;
  onSeeAll: (kind: InsightPriorityKind) => void;
}) {
  const { t } = useAnalytics();
  return (
    <section aria-labelledby="watch-title" className="flex flex-col gap-3">
      <h2 id="watch-title" className={SECTION_TITLE}>
        {t("watch.title")}
      </h2>
      {insights.priorities.length === 0 ? (
        <p className="rounded-2xl border bg-card p-4 text-sm text-muted-foreground">
          {t("watch.empty")}
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-3">
          {insights.priorities.map((priority) => (
            <PriorityCard
              key={priority.kind}
              priority={priority}
              insights={insights}
              rights={rights}
              onSeeAll={onSeeAll}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Change({
  current,
  previous,
  change,
  format,
  prefix,
}: {
  current: number;
  previous: number;
  change: number | null;
  format: (n: number) => string;
  /** « Total du mois » / « Par jour » : mois terminés de durées différentes. */
  prefix?: string;
}) {
  const a = useAnalytics();
  const { t } = a;
  if (change === null) {
    // Période précédente à zéro : jamais de pourcentage trompeur.
    return (
      <p className="text-xs text-muted-foreground">
        {prefix && `${t("sales.prefixed", { prefix })} `}
        {t("sales.previousZero", { amount: format(previous) })}
      </p>
    );
  }
  const flat = current === previous || Math.abs(change) < 1e-9;
  const Icon = flat
    ? MinusIcon
    : change > 0
      ? ArrowUpRightIcon
      : ArrowDownRightIcon;
  const label = flat
    ? t("sales.changeFlat")
    : change > 0
      ? t("sales.changeUp", { pct: a.decimal(change) })
      : t("sales.changeDown", { pct: a.decimal(Math.abs(change)) });
  return (
    <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <Icon aria-hidden className="size-3.5" />
      {prefix && <span>{t("sales.prefixed", { prefix })}</span>}
      <span className="font-medium text-foreground">{label}</span>
      <span>· {t("sales.previousValue", { value: format(previous) })}</span>
    </p>
  );
}

function Kpi({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl border bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold tabular-nums wrap-break-word">{value}</p>
      {children}
    </div>
  );
}

/** Termine une phrase par un seul point (« févr. » en porte déjà un). */
function sentence(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

function gainText(a: AnalyticsFormat, totals: InsightTotals): string {
  return totals.gain === null || totals.gain === undefined
    ? UNKNOWN
    : a.fcfa(totals.gain);
}

export function SalesSection({ insights }: { insights: AnalyticsInsights }) {
  const a = useAnalytics();
  const { t, formatShortDate, formatDateTime } = a;
  const { period, summary, comparison } = insights;
  const from = formatShortDate(period.start);
  const to = period.inProgress
    ? formatShortDate(insights.generatedAt)
    : formatShortDate(lastIncludedDay(period.end));
  const prev = comparison.available ? comparison.totals : null;
  const showGain = insights.rights.financials && "gain" in summary;
  // Mois terminés de durées différentes : le total et le rythme par jour
  // sont présentés séparément (jamais une hausse du total lue comme une
  // accélération des ventes).
  const durations =
    comparison.available &&
    !comparison.partial &&
    comparison.days !== undefined &&
    comparison.previousDays !== undefined &&
    comparison.days !== comparison.previousDays
      ? { days: comparison.days, previousDays: comparison.previousDays }
      : null;
  const perDay = (value: number, days: number) => value / days;
  return (
    <section aria-labelledby="sales-title" className="flex flex-col gap-3">
      <div>
        <h2 id="sales-title" className={SECTION_TITLE}>
          {t("sales.title")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {period.inProgress
            ? t("sales.periodInProgress", { from, to })
            : t("sales.periodClosed", { from, to })}
        </p>
      </div>
      <div
        className={`grid gap-3 ${showGain ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}
      >
        <Kpi label={t("sales.revenue")} value={a.fcfa(summary.revenue)}>
          {prev && comparison.available && (
            <Change
              current={summary.revenue}
              previous={prev.revenue}
              change={comparison.revenueChange}
              format={a.fcfa}
              prefix={durations ? t("sales.totalPrefix") : undefined}
            />
          )}
          {prev && comparison.available && durations && (
            <Change
              current={perDay(summary.revenue, durations.days)}
              previous={perDay(prev.revenue, durations.previousDays)}
              change={comparison.revenuePerDayChange ?? null}
              format={(n) => t("sales.perDayValue", { value: a.fcfa(n) })}
              prefix={t("sales.perDayPrefix")}
            />
          )}
        </Kpi>
        <Kpi label={t("sales.count")} value={a.number(summary.salesCount)}>
          <p className="text-xs text-muted-foreground">
            {t("sales.units", {
              count: summary.unitsSold,
              n: a.number(summary.unitsSold),
            })}
          </p>
          {prev && comparison.available && (
            <Change
              current={summary.salesCount}
              previous={prev.salesCount}
              change={comparison.salesCountChange}
              format={(n) => a.number(n)}
              prefix={durations ? t("sales.totalPrefix") : undefined}
            />
          )}
          {prev && comparison.available && durations && (
            <Change
              current={perDay(summary.salesCount, durations.days)}
              previous={perDay(prev.salesCount, durations.previousDays)}
              change={comparison.salesCountPerDayChange ?? null}
              format={(n) => t("sales.perDayValue", { value: a.decimal(n) })}
              prefix={t("sales.perDayPrefix")}
            />
          )}
        </Kpi>
        {showGain && (
          <Kpi label={t("sales.gain")} value={gainText(a, summary)}>
            <p className="text-xs text-muted-foreground">
              {summary.gain === null
                ? t("sales.gainUnknown")
                : t("sales.gainHint")}
            </p>
            {prev && "gain" in prev && (
              <p className="text-xs text-muted-foreground">
                {t("sales.previousValue", { value: gainText(a, prev) })}
              </p>
            )}
          </Kpi>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {comparison.available
          ? sentence(
              `${t("sales.compareTo", {
                from: formatShortDate(comparison.start),
                to: comparison.partial
                  ? formatDateTime(comparison.end)
                  : formatShortDate(lastIncludedDay(comparison.end)),
              })}${comparison.partial ? ` (${t("sales.compareSameElapsed")})` : ""}`,
            ) +
            (durations
              ? ` ${t("sales.durations", {
                  days: durations.days,
                  previousDays: durations.previousDays,
                })}`
              : "")
          : t(`sales.noComparison.${comparison.reason ?? "none"}`)}{" "}
        {t("recordedSalesNote")}
      </p>
    </section>
  );
}

function TrendBars({ insights }: { insights: AnalyticsInsights }) {
  const a = useAnalytics();
  const { t, formatShortDate } = a;
  const days = insights.trend;
  const max = Math.max(0, ...days.map((d) => d.revenue));
  const total = days.reduce((s, d) => s + d.revenue, 0);
  const best = max > 0 ? days.find((d) => d.revenue === max) : undefined;
  const summary = best
    ? t("sells.trendSummary", {
        count: days.length,
        n: a.number(days.length),
        total: a.fcfa(total),
        best: t("sells.bestDay", {
          date: formatShortDate(best.date + "T12:00:00"),
          amount: a.fcfa(best.revenue),
        }),
      })
    : t("sells.trendNone", { count: days.length, n: a.number(days.length) });
  return (
    <figure className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
      <figcaption className="text-sm">
        <span className="font-medium">{t("sells.trendTitle")}</span>
        <span className="block text-muted-foreground">{summary}</span>
      </figcaption>
      {/* Graphique décoratif : sa lecture textuelle est le résumé ci-dessus
          et le tableau jour par jour. Une seule série, aucune légende. */}
      <div aria-hidden className="flex h-28 items-end gap-0.5">
        {days.map((d) => (
          <div
            key={d.date}
            title={t("sells.barTitle", {
              count: d.salesCount,
              n: a.number(d.salesCount),
              date: formatShortDate(d.date + "T12:00:00"),
              amount: a.fcfa(d.revenue),
            })}
            className="flex h-full flex-1 items-end"
          >
            <div
              className="w-full rounded-t-sm bg-(--tenant-accent)"
              style={{
                height:
                  max > 0 && d.revenue > 0
                    ? `${Math.max(3, (d.revenue / max) * 100)}%`
                    : "1px",
                opacity: d.revenue > 0 ? 1 : 0.35,
              }}
            />
          </div>
        ))}
      </div>
      <details className="text-sm">
        <summary
          className={`${FOCUS} cursor-pointer rounded text-(--tenant-accent-ink)`}
        >
          {t("sells.trendTable")}
        </summary>
        <div className="mt-2 max-h-64 overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th scope="col" className="py-1 text-left">
                  {t("sells.day")}
                </th>
                <th scope="col" className="py-1 text-right">
                  {t("sells.amount")}
                </th>
                <th scope="col" className="py-1 text-right">
                  {t("sells.salesCount")}
                </th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.date} className="border-b last:border-0">
                  <td className="py-1">
                    {formatShortDate(d.date + "T12:00:00")}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {a.fcfa(d.revenue)}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {a.number(d.salesCount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

export function SellsSection({ insights }: { insights: AnalyticsInsights }) {
  const a = useAnalytics();
  const { t } = a;
  return (
    <section aria-labelledby="sells-title" className="flex flex-col gap-3">
      <h2 id="sells-title" className={SECTION_TITLE}>
        {t("sells.title")}
      </h2>
      <div className="grid gap-3 lg:grid-cols-2">
        <TrendBars insights={insights} />
        <div className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
          <h3 className="text-sm font-medium">{t("sells.topTitle")}</h3>
          {insights.topProducts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("sells.topEmpty")}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th scope="col" className="py-1 text-left">
                    {t("sells.product")}
                  </th>
                  <th scope="col" className="py-1 pl-3 text-right">
                    {t("sells.amount")}
                  </th>
                  <th scope="col" className="py-1 pl-3 text-right">
                    {t("sells.quantity")}
                  </th>
                  <th
                    scope="col"
                    className="py-1 pl-3 text-right"
                    title={t("sells.currentStockHint")}
                  >
                    {t("sells.currentStock")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {insights.topProducts.map((p) => (
                  <tr key={p.productId} className="border-b last:border-0">
                    <td className="py-2 pr-2 wrap-break-word">
                      {p.productDeleted ? (
                        <span>
                          {p.name ?? (
                            <span className="italic text-muted-foreground">
                              {t("sells.unnamed")}
                            </span>
                          )}{" "}
                          <span className="text-xs text-muted-foreground">
                            ({t("sells.deleted")})
                          </span>
                        </span>
                      ) : (
                        <Link
                          prefetch={false}
                          href={productHref(p)}
                          className={`${FOCUS} rounded underline-offset-2 hover:underline`}
                        >
                          {p.name ?? t("sells.unnamed")}
                        </Link>
                      )}
                    </td>
                    <td className="py-2 pl-3 text-right tabular-nums whitespace-nowrap">
                      {a.fcfa(p.revenue)}
                    </td>
                    <td className="py-2 pl-3 text-right tabular-nums whitespace-nowrap">
                      {a.number(p.unitsSold)}
                    </td>
                    <td className="py-2 pl-3 text-right tabular-nums whitespace-nowrap">
                      {p.remainingQuantity === null
                        ? UNKNOWN
                        : a.number(p.remainingQuantity)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-xs text-muted-foreground">
            {t("sells.currentStockHint")}
          </p>
        </div>
      </div>
    </section>
  );
}

function estimateText(a: AnalyticsFormat, item: InsightStockItem): string {
  const e = item.estimate;
  if (!e.estimable) {
    return e.reason === "invalid_quantities"
      ? a.t("stock.invalidQuantities")
      : a.t("stock.notEnough");
  }
  const parts: string[] = [
    a.t("stock.perDay", { avg: a.decimal(e.dailyAverage) }),
  ];
  if (e.daysLeft !== null)
    parts.unshift(a.t("stock.daysLeft", { days: a.formatDays(e.daysLeft) }));
  return parts.join(" · ");
}

export type StockSectionKind =
  "out" | "soon" | "price" | "low" | "stale" | "recent";

type ListItem = InsightStockItem | InsightPriceItem;

/**
 * Liste paginée : première page reçue avec l'Analyse, suite chargée à la
 * demande (`/analytics/insights/list`, même ordre stable). Remontée à
 * chaque relecture de l'Analyse (clé), donc toujours repartie de l'état
 * courant ; un produit déjà affiché n'est jamais ajouté deux fois.
 */
function StockList({
  kind,
  count,
  items: firstPage,
  insights,
  rights,
}: {
  kind: StockSectionKind;
  count: number;
  items: ListItem[];
  insights: AnalyticsInsights;
  rights: ProductActionRights;
}) {
  const a = useAnalytics();
  const { t } = a;
  const [items, setItems] = useState<ListItem[]>(firstPage);
  const [total, setTotal] = useState(count);
  const [loadingMore, setLoadingMore] = useState(false);
  // Message de l'API (déjà traduit) ; l'en-tête est traduit au rendu.
  const [loadError, setLoadError] = useState<string | null>(null);
  const titleId = `stock-${kind}-title`;

  const loadMore = async () => {
    setLoadingMore(true);
    setLoadError(null);
    try {
      const page = await fetchInsightList(
        kind,
        items.length,
        insights.period.month,
      );
      setItems((current) => {
        const seen = new Set(current.map((i) => i.productId));
        return [
          ...current,
          ...page.items.filter((i) => !seen.has(i.productId)),
        ];
      });
      setTotal(page.count);
    } catch (err) {
      setLoadError(getApiErrorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const shown = Math.min(items.length, total);
  const next = Math.min(total - items.length, insights.thresholds.listPageSize);
  return (
    <div
      id={`stock-${kind}`}
      aria-labelledby={titleId}
      role="region"
      className="flex flex-col gap-1 scroll-mt-24"
    >
      <h3 id={titleId} className="text-sm font-medium">
        {t("stock.sectionCount", {
          title: t(`stock.sections.${kind}`),
          n: a.number(total),
        })}
      </h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("stock.noneInSection")}
        </p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {items.map((item) => {
            const isPrice = kind === "price";
            const price = item as InsightPriceItem;
            const detail = isPrice
              ? t("stock.priceFacts", {
                  count: price.unitsSold,
                  n: a.number(price.unitsSold),
                  revenue: a.fcfa(price.revenue),
                  cost: a.fcfa(price.purchasePrice),
                  gain: a.fcfa(price.gain),
                })
              : kind === "stale"
                ? t("stock.staleLabel", {
                    days: insights.thresholds.observationWindowDays,
                  })
                : kind === "recent"
                  ? t("stock.recentLabel")
                  : kind === "out"
                    ? null
                    : estimateText(a, item as InsightStockItem);
            const canEdit =
              rights.canAdjustStock && kind !== "stale" && kind !== "recent";
            return (
              <li
                key={item.productId}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium wrap-break-word">
                    {item.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {!isPrice &&
                      remainingText(
                        a,
                        (item as InsightStockItem).remainingQuantity,
                      )}
                    {!isPrice && detail ? " · " : ""}
                    {detail}
                  </p>
                </div>
                <Link
                  prefetch={false}
                  href={canEdit ? editHref(item) : productHref(item)}
                  className={`${FOCUS} shrink-0 rounded text-sm text-(--tenant-accent-ink) underline underline-offset-2 hover:no-underline`}
                >
                  {canEdit
                    ? isPrice
                      ? t("watch.actions.reviewPrice")
                      : t("watch.actions.restock")
                    : t("watch.actions.viewProduct")}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {total > 0 && (
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {t("stock.shownOf", {
              count: shown,
              shown: a.number(shown),
              total: a.number(total),
            })}
          </p>
          {items.length < total && (
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              aria-busy={loadingMore}
              className={`${FOCUS} min-h-10 rounded-lg border border-(--tenant-accent-border) px-3 text-sm font-medium text-(--tenant-accent-ink) hover:bg-(--tenant-accent-soft) disabled:opacity-60`}
            >
              {loadingMore
                ? t("loading")
                : t("stock.showMore", { count: next })}
            </button>
          )}
        </div>
      )}
      {loadError && (
        <p role="alert" className="text-xs text-destructive">
          {t("stock.loadError")} {loadError}
        </p>
      )}
    </div>
  );
}

export function StockDetails({
  insights,
  rights,
}: {
  insights: AnalyticsInsights;
  rights: ProductActionRights;
}) {
  const { t, formatShortDate } = useAnalytics();
  const { stock } = insights;
  const w = stock.window;
  const sections: Array<{
    kind: StockSectionKind;
    count: number;
    items: Array<InsightStockItem | InsightPriceItem>;
  }> = [
    { kind: "out", ...stock.out },
    { kind: "soon", ...stock.soon },
    ...(insights.priceChecks
      ? [{ kind: "price" as const, ...insights.priceChecks }]
      : []),
    { kind: "low", ...stock.low },
    { kind: "stale", ...stock.stale },
    { kind: "recent", ...stock.recent },
  ];
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        {t("stock.windowNote", {
          days: w.days,
          from: formatShortDate(w.start),
          to: formatShortDate(lastIncludedDay(w.end)),
        })}
      </p>
      {sections.map((s) => (
        <StockList
          key={`${s.kind}-${insights.generatedAt}`}
          kind={s.kind}
          count={s.count}
          items={s.items}
          insights={insights}
          rights={rights}
        />
      ))}
    </div>
  );
}
