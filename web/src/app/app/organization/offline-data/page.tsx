"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { purgeAllOfflineData } from "@/lib/offline-purge";

// Purge manuelle du catalogue hors ligne (1-11B) — accessible à tout membre
// actif, sans permission particulière (aucune donnée d'organisation autre
// que la sienne n'est jamais exposée ici, la base est simplement effacée).
export default function OfflineDataPage() {
  const [clearing, setClearing] = useState(false);

  const handleClear = async () => {
    setClearing(true);
    try {
      const ok = await purgeAllOfflineData();
      toast[ok ? "success" : "error"](
        ok
          ? "Données hors connexion supprimées."
          : "Impossible de supprimer les données hors connexion.",
      );
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="max-w-md space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Données hors connexion</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Stock Master conserve une copie en lecture seule du dernier catalogue
          chargé avec succès (sections, produits, stock, prix) pour le consulter
          sans connexion, pendant 72 heures maximum. Aucune vente, image, donnée
          d&apos;audit ou d&apos;une autre organisation n&apos;y est jamais
          stockée.
        </p>
      </div>
      <Button
        variant="outline"
        onClick={() => void handleClear()}
        disabled={clearing}
      >
        {clearing ? "Suppression…" : "Supprimer les données hors connexion"}
      </Button>
    </div>
  );
}
