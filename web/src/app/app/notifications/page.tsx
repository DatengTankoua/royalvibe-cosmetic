"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getApiErrorMessage } from "@/lib/api";
import { getToken } from "@/lib/auth";
import { createResponseOrder } from "@/lib/refresh-coordinator";
import { useLiveRefresh, useSocketSignals } from "@/hooks/use-live-refresh";
import {
  AppNotification,
  NOTIFICATIONS_CHANGED,
  fetchNotifications,
  markAllNotificationsRead,
} from "@/lib/notifications";

const PAGE = 20;
const timeFormat = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "medium",
  timeStyle: "short",
});

/** Première page relue fusionnée avec les pages déjà chargées. */
function merge(
  current: AppNotification[],
  firstPage: AppNotification[],
): AppNotification[] {
  const fresh = new Map(firstPage.map((n) => [n.id, n]));
  const rest = current.filter((n) => !fresh.has(n.id));
  return [...firstPage, ...rest].sort((a, b) => (a.id < b.id ? 1 : -1));
}

// Centre de notifications (1-16A.1) : toutes / non lues, pagination,
// « Tout marquer comme lu ». Consulter la liste ne marque rien comme lu ;
// ouvrir une notification la marque lue (page de détail).
export default function NotificationsPage() {
  const [status, setStatus] = useState<"all" | "unread">("all");
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const order = useRef(createResponseOrder());

  const loadFirst = useCallback(
    async (mode: "reset" | "merge") => {
      const token = getToken();
      const started = Date.now();
      const ticket = order.current.begin();
      const page = await fetchNotifications({ status, limit: PAGE });
      if (getToken() !== token || !order.current.accept(ticket)) return;
      setFailed(false);
      setLoadedAt(started);
      if (mode === "reset") {
        setItems(page.items);
        setCursor(page.nextCursor);
      } else {
        setItems((current) =>
          current ? merge(current, page.items) : page.items,
        );
      }
    },
    [status],
  );

  useEffect(() => {
    setItems(null);
    setCursor(null);
    loadFirst("reset").catch(() => setFailed(true));
  }, [loadFirst]);

  const request = useLiveRefresh(
    () => loadFirst("merge").catch(() => undefined),
    loadedAt,
  );
  useSocketSignals([NOTIFICATIONS_CHANGED], request);

  const loadMore = async () => {
    if (!cursor) return;
    setBusy(true);
    try {
      const page = await fetchNotifications({
        status,
        limit: PAGE,
        before: cursor,
      });
      setItems((current) => [...(current ?? []), ...page.items]);
      setCursor(page.nextCursor);
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const readAll = async () => {
    setBusy(true);
    try {
      await markAllNotificationsRead();
      await loadFirst("reset");
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">Notifications</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void readAll()}
          disabled={busy || !items?.some((n) => !n.readAt)}
        >
          Tout marquer comme lu
        </Button>
      </div>
      <div
        role="tablist"
        aria-label="Filtre"
        className="mt-4 flex gap-1 border-b"
      >
        {(
          [
            ["all", "Toutes"],
            ["unread", "Non lues"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={status === value}
            onClick={() => setStatus(value)}
            className={`rounded-t-md px-3 py-2 text-sm font-medium ${
              status === value
                ? "border-b-2 border-(--tenant-accent) text-(--tenant-accent-ink)"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="mt-4">
        {failed ? (
          <p className="text-sm text-muted-foreground">
            Notifications indisponibles pour le moment.
          </p>
        ) : items === null ? (
          <p className="text-sm text-muted-foreground">Chargement…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {status === "unread"
              ? "Aucune notification non lue."
              : "Aucune notification."}
          </p>
        ) : (
          <ul
            className="divide-y rounded-md border"
            data-testid="notification-list"
          >
            {items.map((n) => (
              <li key={n.id}>
                <Link
                  prefetch={false}
                  href={`/app/notifications/${n.id}`}
                  className="flex gap-3 px-3 py-3 text-sm hover:bg-muted"
                >
                  <span
                    aria-hidden="true"
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                      n.readAt ? "bg-transparent" : "bg-red-600"
                    }`}
                  />
                  <span className="min-w-0">
                    <span className={n.readAt ? "" : "font-medium"}>
                      {n.body}
                    </span>
                    {!n.readAt && <span className="sr-only"> (non lue)</span>}
                    <span className="block text-xs text-muted-foreground">
                      {timeFormat.format(new Date(n.createdAt))}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {cursor && (
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => void loadMore()}
            disabled={busy}
          >
            Afficher plus
          </Button>
        )}
      </div>
    </div>
  );
}
