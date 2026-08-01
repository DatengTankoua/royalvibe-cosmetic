"use client";

import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";

export function useSocket(): Socket | null {
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    const instance = io(process.env.NEXT_PUBLIC_API_URL, {
      transports: ["websocket"],
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- exposes the connection instance created by this effect, per React's external-system pattern
    setSocket(instance);

    return () => {
      instance.disconnect();
    };
  }, []);

  return socket;
}
