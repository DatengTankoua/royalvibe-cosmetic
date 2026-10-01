"use client";

import { useState } from "react";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import { SubscriptionManager } from "@/components/subscription/subscription-manager";

// 1-14C.2 — Espace Abonnement du PROPRIÉTAIRE réel (session applicative
// active). Droit dérivé du contexte serveur (rôle de la membership) ; aucun
// appel n'est fait pour un autre membre. Le serveur reste l'autorité
// (`billing.identity`, owner-only). « Vérifier » relit le contexte du shell :
// un blocage éventuel y est appliqué.
export default function OrganizationSubscriptionPage() {
  const { authContext, refreshShell } = useOrganizationShell();
  const [reloadKey, setReloadKey] = useState(0);
  const [verifying, setVerifying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!authContext) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Chargement…
      </p>
    );
  }
  if (authContext.role !== "owner") {
    return (
      <p className="text-sm text-muted-foreground">
        La gestion de l&apos;abonnement est réservée au propriétaire du
        commerce.
      </p>
    );
  }

  const verify = () => {
    setVerifying(true);
    setMessage(null);
    refreshShell();
    setReloadKey((v) => v + 1);
    setVerifying(false);
    setMessage("Abonnement vérifié.");
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Abonnement</h2>
      <SubscriptionManager
        serverNow={authContext.access?.checkedAt ?? null}
        reloadKey={reloadKey}
        onVerify={verify}
        verifying={verifying}
        verifyMessage={message}
      />
    </div>
  );
}
