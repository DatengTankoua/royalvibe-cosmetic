"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useT } from "next-i18next/client";
import { Button } from "@/components/ui/button";
import { purgeAllOfflineData } from "@/lib/offline-purge";

// Purge manuelle du catalogue hors ligne (1-11B) — accessible à tout membre
// actif, sans permission particulière (aucune donnée d'organisation autre
// que la sienne n'est jamais exposée ici, la base est simplement effacée).
export default function OfflineDataPage() {
  const { t } = useT("organization");
  const [clearing, setClearing] = useState(false);

  const handleClear = async () => {
    setClearing(true);
    try {
      const ok = await purgeAllOfflineData();
      toast[ok ? "success" : "error"](
        ok ? t("offlineData.cleared") : t("offlineData.clearFailed"),
      );
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="max-w-md space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{t("offlineData.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("offlineData.text")}
        </p>
      </div>
      <Button
        variant="outline"
        onClick={() => void handleClear()}
        disabled={clearing}
      >
        {clearing ? t("deleting") : t("offlineData.clear")}
      </Button>
    </div>
  );
}
