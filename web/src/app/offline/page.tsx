"use client";

import { WifiOffIcon } from "lucide-react";
import { Wordmark } from "@/components/brand/wordmark";

// Page de repli hors connexion (1-11A) : servie par le service worker
// (public/sw.js) quand une navigation publique échoue sans réseau. Aucune
// donnée métier, aucune mutation ni appel réseau déclenché ici.
export default function OfflinePage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-12 text-center">
      <Wordmark size="medium" />
      <WifiOffIcon className="size-10 text-muted-foreground" aria-hidden />
      <h1 className="text-xl font-bold">Vous êtes hors connexion</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        Les données de gestion (catalogue, ventes, analyses) et toute
        modification nécessitent une connexion Internet. Reconnecte-toi puis
        réessaie.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium text-white"
        style={{ backgroundColor: "var(--brand-navy)" }}
      >
        Réessayer
      </button>
    </div>
  );
}
