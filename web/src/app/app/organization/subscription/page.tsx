"use client";

import { useState } from "react";
import { useT } from "next-i18next/client";
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
  const { t } = useT("subscription");
  const [verified, setVerified] = useState(false);

  if (!authContext) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t("page.loading")}
      </p>
    );
  }
  if (authContext.role !== "owner") {
    return (
      <p className="text-sm text-muted-foreground">{t("page.ownerOnly")}</p>
    );
  }

  const verify = () => {
    setVerifying(true);
    setVerified(false);
    refreshShell();
    setReloadKey((v) => v + 1);
    setVerifying(false);
    setVerified(true);
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">{t("page.title")}</h2>
      <SubscriptionManager
        identity={{
          userId: authContext.userId,
          organizationId: authContext.organizationId,
        }}
        serverNow={authContext.access?.checkedAt ?? null}
        reloadKey={reloadKey}
        onVerify={verify}
        verifying={verifying}
        verifyMessage={verified ? t("page.verified") : null}
      />
    </div>
  );
}
