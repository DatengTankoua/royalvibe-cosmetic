"use client";

import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { getToken } from "@/lib/auth";

export function useSocket(): Socket | null {
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    const token = getToken();
    const instance = io(process.env.NEXT_PUBLIC_API_URL, {
      transports: ["websocket"],
      auth: token ? { token } : undefined,
    });
    // setSocket exposes the connection created by this effect — the external-system pattern
    setSocket(instance);

    return () => {
      instance.disconnect();
    };
  }, []);

  return socket;
}
