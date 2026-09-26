"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { getToken } from "@/lib/auth";
import { useAuth } from "@/contexts/auth-context";

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
const SocketContext = createContext<Socket | null>(null);

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const { user, sessionVersion } = useAuth();
  const userId: string | null = user?._id ?? null;

  useEffect(() => {
    if (!userId) {
      return;
    }
    const token = getToken();
    const instance = io(process.env.NEXT_PUBLIC_API_URL, {
      transports: ["websocket"],
      auth: token ? { token } : undefined,
    });
    setSocket(instance);

    return () => {
      instance.disconnect();
      setSocket(null);
    };
  }, [userId, sessionVersion]);

  return (
    <SocketContext.Provider value={socket}>{children}</SocketContext.Provider>
  );
}

export function useSocket(): Socket | null {
  return useContext(SocketContext);
}
