"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BellIcon } from "lucide-react";
import { getToken } from "@/lib/auth";
import { createResponseOrder } from "@/lib/refresh-coordinator";
import { useLiveRefresh, useSocketSignals } from "@/hooks/use-live-refresh";
import {
  AppNotification,
  NOTIFICATIONS_CHANGED,
  badgeLabel,
  fetchNotifications,
  fetchUnreadCount,
} from "@/lib/notifications";

const RECENT = 5;

const timeFormat = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "short",
  timeStyle: "short",
});

// Cloche du centre de notifications (1-16A.1), dans l'en-tête juste avant le
// nom de l'utilisateur.
// - Compteur des non lues relu par l'API ; actualisé par le signal privé
//   `notifications:changed` via le coordinateur 1-15A (regroupement,
//   rattrapage à la reconnexion), sans polling.
// - Réponse ignorée si la session a changé pendant la requête (autre jeton)
//   ou si une réponse plus récente a déjà été appliquée.
// - Ouvrir le panneau NE marque RIEN comme lu : seule l'ouverture d'une
//   notification (page de détail) ou « Tout marquer comme lu » le font.
export function NotificationBell() {
  const [count, setCount] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<AppNotification[] | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | undefined>(undefined);
  const countOrder = useRef(createResponseOrder());
  const listOrder = useRef(createResponseOrder());
  const openRef = useRef(open);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    openRef.current = open;
  });

  const loadRecent = useCallback(async () => {
    const token = getToken();
    const ticket = listOrder.current.begin();
    try {
      const page = await fetchNotifications({ status: "all", limit: RECENT });
      if (getToken() !== token || !listOrder.current.accept(ticket)) return;
      setRecent(page.items);
    } catch {
      // Affichage conservé.
    }
  }, []);

  const refresh = useCallback(async () => {
    const token = getToken();
    const started = Date.now();
    const ticket = countOrder.current.begin();
    const value = await fetchUnreadCount();
    if (getToken() !== token || !countOrder.current.accept(ticket)) return;
    setCount(value);
    setLoadedAt(started);
    if (openRef.current) await loadRecent();
  }, [loadRecent]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const request = useLiveRefresh(
    () => refresh().catch(() => undefined),
    loadedAt,
  );
  useSocketSignals([NOTIFICATIONS_CHANGED], request);

  useEffect(() => {
    if (!open) return;
    void loadRecent();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, loadRecent]);

  const unread = count ?? 0;
  const label =
    unread === 0
      ? "Notifications, aucune non lue"
      : `Notifications, ${unread > 99 ? "plus de 99" : unread} non ${
          unread > 1 ? "lues" : "lue"
        }`;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="notification-bell-panel"
        data-testid="notification-bell"
        className="relative rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <BellIcon className="h-4 w-4" aria-hidden="true" />
        {unread > 0 && (
          <span
            data-testid="notification-badge"
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] font-semibold leading-4 text-white"
          >
            {badgeLabel(unread)}
          </span>
        )}
      </button>
      {open && (
        <div
          id="notification-bell-panel"
          role="dialog"
          aria-label="Notifications récentes"
          className="absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-md border bg-background p-2 shadow-lg"
        >
          <p className="px-2 py-1 text-sm font-semibold">Notifications</p>
          {recent === null ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              Chargement…
            </p>
          ) : recent.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              Aucune notification.
            </p>
          ) : (
            <ul className="max-h-80 overflow-y-auto">
              {recent.map((n) => (
                <li key={n.id}>
                  <Link
                    prefetch={false}
                    href={`/app/notifications/${n.id}`}
                    onClick={() => setOpen(false)}
                    className="flex gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted"
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
          <Link
            prefetch={false}
            href="/app/notifications"
            onClick={() => setOpen(false)}
            className="mt-1 block rounded-md px-2 py-2 text-center text-sm font-medium text-(--tenant-accent-ink) hover:bg-muted"
          >
            Voir toutes les notifications
          </Link>
        </div>
      )}
    </div>
  );
}
