"use client";

import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { getToken } from "@/lib/auth";
import { useAuth } from "@/contexts/auth-context";

// Phase 0B.3 : le handshake Socket.IO exige un JWT validé côté serveur.
// - user absent (non connecté / après déconnexion) -> aucun socket ;
//   l'effet (cleanup) coupe la connexion existante ;
// - user présent (après login/register) -> nouvelle connexion
//   authentifiée avec le token courant.
// Le token n'est JAMAIS journalisé.
//
// Dépendance primitive stable sur l'IDENTITÉ du user (`user?._id`) et non
// l'objet `user` complet : si la référence de `user` changeait à contenu
// identique (re-mount / refresh du provider), la connexion serait
// inutilement coupée-et-rouverte. Le re-login d'un user DIFFÉRENT (autre
// `_id`) ou le logout (`null`) restaure le redémarrage d'effet.
// `sessionVersion` (1-9B) : incrémenté à chaque changement de JWT (switch
// d'organisation compris) — même `userId`, mais le token a changé, donc la
// connexion existante doit être coupée puis rouverte avec le nouveau token.
export function useSocket(): Socket | null {
  const [socket, setSocket] = useState<Socket | null>(null);
  const { user, sessionVersion } = useAuth();
  // Identité primitive stable (string | null).
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
    // setSocket exposes the connection created by this effect — the external-system pattern
    setSocket(instance);

    return () => {
      instance.disconnect();
      setSocket(null);
    };
  }, [userId, sessionVersion]);

  return socket;
}
