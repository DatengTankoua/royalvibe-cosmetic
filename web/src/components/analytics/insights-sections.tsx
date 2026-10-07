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
import { fmtXof } from "@/lib/currency";
import { analyticsLabels } from "@/lib/analytics-labels";

// 1-16E — sections de la page Analyse. Aucun calcul de décision ici : les
// listes, seuils et estimations viennent du serveur (valeurs non arrondies) ;
// ce module n'arrondit que pour l'affichage.

const L = analyticsLabels();
// 1-15D : un chiffre inconnu s'affiche « — », jamais 0.
export const UNKNOWN = "—";

export const FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-(--tenant-accent-ring) focus-visible:ring-offset-2";
const SECTION_TITLE = "text-lg font-semibold";
const ACTION_PRIMARY = `${FOCUS} inline-flex min-h-10 items-center rounded-lg bg-(--tenant-accent) px-3 text-sm font-medium text-(--tenant-accent-foreground) hover:ring-2 hover:ring-(--tenant-accent-border)`;
const ACTION_SECONDARY = `${FOCUS} inline-flex min-h-10 items-center rounded-lg border border-(--tenant-accent-border) px-3 text-sm font-medium text-(--tenant-accent-ink) hover:bg-(--tenant-accent-soft)`;

const number = new Intl.NumberFormat("fr-FR");
const decimal = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });

/** Jours estimés : 1 décimale sous 10 jours, entier au-delà (affichage seul). */
export function formatDays(days: number): string {
  return days < 10 ? decimal.format(days) : number.format(Math.floor(days));
}

export function formatShortDate(value: string | Date): string {
  return new Date(value).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "short",
  });
}

function formatDateTime(value: string | Date): string {
  return new Date(value).toLocaleString("fr-FR", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

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

function stockFact(item: InsightStockItem, kind: InsightPriorityKind): string {
  const e = item.estimate;
  const base = `${item.name} : ${L.stock.remaining(item.remainingQuantity)}`;
  if (kind === "soon" && e.estimable && e.daysLeft !== null) {
    return `${base}, ${L.stock.daysLeft(formatDays(e.daysLeft))}`;
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
  const k = L.watch.kinds[priority.kind];
  const kinds = L.watch.kinds;
  const Icon = KIND_ICON[priority.kind];
  const t = insights.thresholds;
  const first = priority.items[0];
  const fact =
    priority.kind === "price"
      ? `${(first as InsightPriceItem).name} : gain estimé ${fmtXof((first as InsightPriceItem).gain)}`
      : stockFact(first as InsightStockItem, priority.kind);
  const reason =
    priority.kind === "soon"
      ? kinds.soon.reason(t.soonStockoutDays)
      : priority.kind === "stale"
        ? kinds.stale.reason(t.observationWindowDays)
        : kinds[priority.kind].reason;
  const action =
    rights.canAdjustStock && priority.kind !== "stale"
      ? {
          href: editHref(first),
          label:
            priority.kind === "price"
              ? L.watch.actions.reviewPrice
              : L.watch.actions.restock,
        }
      : { href: productHref(first), label: L.watch.actions.viewProduct };
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
          {k.title}
        </h3>
      </div>
      <p className="text-sm text-muted-foreground">{k.count(priority.count)}</p>
      <p className="text-sm font-medium wrap-break-word">
        {fact}{" "}
        <span className="font-normal text-muted-foreground">
          {L.watch.andOthers(priority.count - 1)}
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
            {L.watch.seeAll(priority.count)}
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
  return (
    <section aria-labelledby="watch-title" className="flex flex-col gap-3">
      <h2 id="watch-title" className={SECTION_TITLE}>
        {L.watch.title}
      </h2>
      {insights.priorities.length === 0 ? (
        <p className="rounded-2xl border bg-card p-4 text-sm text-muted-foreground">
          {L.watch.empty}
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
  if (change === null) {
    // Période précédente à zéro : jamais de pourcentage trompeur.
    return (
      <p className="text-xs text-muted-foreground">
        {prefix && `${prefix} : `}
        {L.sales.previousZero(format(previous))}
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
    ? L.sales.changeFlat
    : change > 0
      ? L.sales.changeUp(decimal.format(change))
      : L.sales.changeDown(decimal.format(Math.abs(change)));
  return (
    <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <Icon aria-hidden className="size-3.5" />
      {prefix && <span>{prefix} :</span>}
      <span className="font-medium text-foreground">{label}</span>
      <span>· {L.sales.previousValue(format(previous))}</span>
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

function gainText(totals: InsightTotals): string {
  return totals.gain === null || totals.gain === undefined
    ? UNKNOWN
    : fmtXof(totals.gain);
}

export function SalesSection({ insights }: { insights: AnalyticsInsights }) {
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
          {L.sales.title}
        </h2>
        <p className="text-sm text-muted-foreground">
          {period.inProgress
            ? L.sales.periodInProgress(from, to)
            : L.sales.periodClosed(from, to)}
        </p>
      </div>
      <div
        className={`grid gap-3 ${showGain ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}
      >
        <Kpi label={L.sales.revenue} value={fmtXof(summary.revenue)}>
          {prev && comparison.available && (
            <Change
              current={summary.revenue}
              previous={prev.revenue}
              change={comparison.revenueChange}
              format={fmtXof}
              prefix={durations ? L.sales.totalPrefix : undefined}
            />
          )}
          {prev && comparison.available && durations && (
            <Change
              current={perDay(summary.revenue, durations.days)}
              previous={perDay(prev.revenue, durations.previousDays)}
              change={comparison.revenuePerDayChange ?? null}
              format={(n) => L.sales.perDayValue(fmtXof(n))}
              prefix={L.sales.perDayPrefix}
            />
          )}
        </Kpi>
        <Kpi label={L.sales.count} value={number.format(summary.salesCount)}>
          <p className="text-xs text-muted-foreground">
            {L.sales.units(summary.unitsSold)}
          </p>
          {prev && comparison.available && (
            <Change
              current={summary.salesCount}
              previous={prev.salesCount}
              change={comparison.salesCountChange}
              format={(n) => number.format(n)}
              prefix={durations ? L.sales.totalPrefix : undefined}
            />
          )}
          {prev && comparison.available && durations && (
            <Change
              current={perDay(summary.salesCount, durations.days)}
              previous={perDay(prev.salesCount, durations.previousDays)}
              change={comparison.salesCountPerDayChange ?? null}
              format={(n) => L.sales.perDayValue(decimal.format(n))}
              prefix={L.sales.perDayPrefix}
            />
          )}
        </Kpi>
        {showGain && (
          <Kpi label={L.sales.gain} value={gainText(summary)}>
            <p className="text-xs text-muted-foreground">
              {summary.gain === null ? L.sales.gainUnknown : L.sales.gainHint}
            </p>
            {prev && "gain" in prev && (
              <p className="text-xs text-muted-foreground">
                {L.sales.previousValue(gainText(prev))}
              </p>
            )}
          </Kpi>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {comparison.available
          ? sentence(
              `${L.sales.compareTo(
                formatShortDate(comparison.start),
                comparison.partial
                  ? formatDateTime(comparison.end)
                  : formatShortDate(lastIncludedDay(comparison.end)),
              )}${comparison.partial ? ` (${L.sales.compareSameElapsed})` : ""}`,
            ) +
            (durations
              ? ` ${L.sales.durations(durations.days, durations.previousDays)}`
              : "")
          : L.sales.noComparison[comparison.reason ?? "none"]}{" "}
        {L.recordedSalesNote}
      </p>
    </section>
  );
}

function TrendBars({ insights }: { insights: AnalyticsInsights }) {
  const days = insights.trend;
  const max = Math.max(0, ...days.map((d) => d.revenue));
  const total = days.reduce((s, d) => s + d.revenue, 0);
  const best = max > 0 ? days.find((d) => d.revenue === max) : undefined;
  const summary = L.sells.trendSummary(
    fmtXof(total),
    best
      ? `${formatShortDate(best.date + "T12:00:00")} (${fmtXof(best.revenue)})`
      : null,
    days.length,
  );
  return (
    <figure className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
      <figcaption className="text-sm">
        <span className="font-medium">{L.sells.trendTitle}</span>
        <span className="block text-muted-foreground">{summary}</span>
      </figcaption>
      {/* Graphique décoratif : sa lecture textuelle est le résumé ci-dessus
          et le tableau jour par jour. Une seule série, aucune légende. */}
      <div aria-hidden className="flex h-28 items-end gap-0.5">
        {days.map((d) => (
          <div
            key={d.date}
            title={`${formatShortDate(d.date + "T12:00:00")} : ${fmtXof(d.revenue)} · ${d.salesCount} vente(s)`}
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
          {L.sells.trendTable}
        </summary>
        <div className="mt-2 max-h-64 overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th scope="col" className="py-1 text-left">
                  {L.sells.day}
                </th>
                <th scope="col" className="py-1 text-right">
                  {L.sells.amount}
                </th>
                <th scope="col" className="py-1 text-right">
                  {L.sells.salesCount}
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
                    {fmtXof(d.revenue)}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {number.format(d.salesCount)}
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
  return (
    <section aria-labelledby="sells-title" className="flex flex-col gap-3">
      <h2 id="sells-title" className={SECTION_TITLE}>
        {L.sells.title}
      </h2>
      <div className="grid gap-3 lg:grid-cols-2">
        <TrendBars insights={insights} />
        <div className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
          <h3 className="text-sm font-medium">{L.sells.topTitle}</h3>
          {insights.topProducts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{L.sells.topEmpty}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th scope="col" className="py-1 text-left">
                    {L.sells.product}
                  </th>
                  <th scope="col" className="py-1 pl-3 text-right">
                    {L.sells.amount}
                  </th>
                  <th scope="col" className="py-1 pl-3 text-right">
                    {L.sells.quantity}
                  </th>
                  <th
                    scope="col"
                    className="py-1 pl-3 text-right"
                    title={L.sells.currentStockHint}
                  >
                    {L.sells.currentStock}
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
                              {L.sells.unnamed}
                            </span>
                          )}{" "}
                          <span className="text-xs text-muted-foreground">
                            ({L.sells.deleted})
                          </span>
                        </span>
                      ) : (
                        <Link
                          prefetch={false}
                          href={productHref(p)}
                          className={`${FOCUS} rounded underline-offset-2 hover:underline`}
                        >
                          {p.name ?? L.sells.unnamed}
                        </Link>
                      )}
                    </td>
                    <td className="py-2 pl-3 text-right tabular-nums whitespace-nowrap">
                      {fmtXof(p.revenue)}
                    </td>
                    <td className="py-2 pl-3 text-right tabular-nums whitespace-nowrap">
                      {number.format(p.unitsSold)}
                    </td>
                    <td className="py-2 pl-3 text-right tabular-nums whitespace-nowrap">
                      {p.remainingQuantity === null
                        ? UNKNOWN
                        : number.format(p.remainingQuantity)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-xs text-muted-foreground">
            {L.sells.currentStockHint}
          </p>
        </div>
      </div>
    </section>
  );
}

function estimateText(item: InsightStockItem): string {
  const e = item.estimate;
  if (!e.estimable) {
    return e.reason === "invalid_quantities"
      ? L.stock.invalidQuantities
      : L.stock.notEnough;
  }
  const parts = [L.stock.perDay(decimal.format(e.dailyAverage))];
  if (e.daysLeft !== null)
    parts.unshift(L.stock.daysLeft(formatDays(e.daysLeft)));
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
  const [items, setItems] = useState<ListItem[]>(firstPage);
  const [total, setTotal] = useState(count);
  const [loadingMore, setLoadingMore] = useState(false);
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
      setLoadError(`${L.stock.loadError} ${getApiErrorMessage(err)}`);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div
      id={`stock-${kind}`}
      aria-labelledby={titleId}
      role="region"
      className="flex flex-col gap-1 scroll-mt-24"
    >
      <h3 id={titleId} className="text-sm font-medium">
        {L.stock.sections[kind]} ({number.format(total)})
      </h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{L.stock.noneInSection}</p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {items.map((item) => {
            const isPrice = kind === "price";
            const detail = isPrice
              ? L.stock.priceFacts(
                  fmtXof((item as InsightPriceItem).revenue),
                  (item as InsightPriceItem).unitsSold,
                  fmtXof((item as InsightPriceItem).purchasePrice),
                  fmtXof((item as InsightPriceItem).gain),
                )
              : kind === "stale"
                ? L.stock.staleLabel(insights.thresholds.observationWindowDays)
                : kind === "recent"
                  ? L.stock.recentLabel
                  : kind === "out"
                    ? null
                    : estimateText(item as InsightStockItem);
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
                      L.stock.remaining(
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
                      ? L.watch.actions.reviewPrice
                      : L.watch.actions.restock
                    : L.watch.actions.viewProduct}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {total > 0 && (
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {L.stock.shownOf(Math.min(items.length, total), total)}
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
                ? L.loading
                : L.stock.showMore(
                    Math.min(
                      total - items.length,
                      insights.thresholds.listPageSize,
                    ),
                  )}
            </button>
          )}
        </div>
      )}
      {loadError && (
        <p role="alert" className="text-xs text-destructive">
          {loadError}
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
        {L.stock.windowNote(
          w.days,
          formatShortDate(w.start),
          formatShortDate(lastIncludedDay(w.end)),
        )}
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
