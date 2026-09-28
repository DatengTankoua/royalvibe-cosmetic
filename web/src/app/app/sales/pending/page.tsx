"use client";

import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";
import { PendingSalesPanel } from "@/components/sales/pending-sales-panel";

// /app/sales/pending (1-11C.3) : ventes saisies sur cet appareil pour la
// partition COURANTE (utilisateur + organisation), en attente, en envoi ou
// à traiter. Le serveur reste l'autorité finale à la synchronisation.
export default function PendingSalesPage() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
      <div className="space-y-2">
        <Link
          href="/app/sales"
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-sm hover:bg-muted"
        >
          <ArrowLeftIcon className="h-4 w-4" aria-hidden />
          Ventes
        </Link>
        <h1 className="text-2xl font-semibold">Ventes en attente</h1>
        <p className="text-sm text-muted-foreground">
          Ventes enregistrées sur cet appareil et pas encore confirmées par le
          serveur. Aucune n&apos;est supprimée sans ton accord.
        </p>
      </div>
      <PendingSalesPanel />
    </div>
  );
}
