"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { getToken } from "@/lib/auth";
import { useAuth } from "@/contexts/auth-context";
import { useOnlineStatus } from "@/hooks/use-online-status";

// Connexion Socket.IO unique du shell authentifié (1-9D) : ouverte une seule
// fois ici (montée par AppShellLayout), jamais par une page ou un hook
// individuel — toutes les pages métier sous /app/* consomment cette même
// connexion via useSocket(). Le token n'est JAMAIS journalisé.
//
// Dépendance primitive stable sur l'IDENTITÉ du user (`user?._id`) et non
// l'objet `user` complet — évite une coupure/réouverture inutile si la
// référence de `user` change à contenu identique. `sessionVersion` (1-9B) :
// incrémenté à chaque changement de JWT (switch d'organisation compris) —
// la connexion existante doit alors être coupée puis rouverte avec le
// nouveau token.
//
// Correctif 1-11C.3 : hors ligne (`navigator.onLine === false`), le socket
// est fermé (cleanup de l'effet) et aucun n'est recréé — plus de boucle de
// reconnexion. Un seul nouveau socket, avec le token courant, à l'événement
// `online`.
const SocketContext = createContext<Socket | null>(null);

// 1-15A — instant (horloge locale) de la DERNIÈRE connexion établie du socket
// courant : première connexion, reconnexion automatique de Socket.IO après
// une perte de transport, nouveau socket au retour du réseau ou après un
// redémarrage. Les événements émis avant l'entrée dans la room ne sont
// jamais rejoués : une donnée dont la dernière lecture a COMMENCÉ avant cet
// instant doit être relue (rattrapage). `null` tant qu'aucune connexion.
const SocketConnectedAtContext = createContext<number | null>(null);

// 1-14C.2 : monté UNIQUEMENT quand l'accès applicatif est ouvert (le shell
// ne le rend pas sous un blocage commercial ; jamais avec un jeton limité).
// Une déconnexion décidée par le SERVEUR (`io server disconnect`, ex.
// échéance de couverture) n'est jamais suivie d'une reconnexion automatique
// (comportement Socket.IO) : `onServerDisconnect` demande au shell de relire
// le contexte, qui bascule si besoin sur l'écran de blocage — aucune boucle.
//
// 1-15A : `restartKey` — changé par le shell quand le contexte relu après
// une déconnexion serveur reste valide (droits modifiés, membership
// toujours active) : un seul nouveau socket, avec le token courant. Sans
// cela, le temps réel restait coupé jusqu'au rechargement de la page.
export function SocketProvider({
  children,
  onServerDisconnect,
  restartKey = 0,
}: {
  children: React.ReactNode;
  onServerDisconnect?: () => void;
  restartKey?: number;
}) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const onServerDisconnectRef = useRef(onServerDisconnect);
  useEffect(() => {
    onServerDisconnectRef.current = onServerDisconnect;
  }, [onServerDisconnect]);
  const { user, sessionVersion } = useAuth();
  const online = useOnlineStatus();
  const userId: string | null = user?._id ?? null;

  useEffect(() => {
    if (!userId || !online) {
      return;
    }
    const token = getToken();
    const instance = io(process.env.NEXT_PUBLIC_API_URL, {
      transports: ["websocket"],
      auth: token ? { token } : undefined,
    });
    instance.on("connect", () => setConnectedAt(Date.now()));
    instance.on("disconnect", (reason) => {
      if (reason === "io server disconnect") onServerDisconnectRef.current?.();
    });
    setSocket(instance);

    return () => {
      instance.disconnect();
      setSocket(null);
    };
  }, [userId, sessionVersion, online, restartKey]);

  return (
    <SocketContext.Provider value={socket}>
      <SocketConnectedAtContext.Provider value={connectedAt}>
        {children}
      </SocketConnectedAtContext.Provider>
    </SocketContext.Provider>
  );
}

export function useSocket(): Socket | null {
  return useContext(SocketContext);
}

export function useSocketConnectedAt(): number | null {
  return useContext(SocketConnectedAtContext);
}
