import { getApiErrorCode, getApiErrorMessage } from "@/lib/api";

// Codes métier stables renvoyés par l'API (organizations.service.ts) —
// traduits en messages utilisateur ; tout code inconnu retombe sur le
// message générique de `getApiErrorMessage` (jamais de détail technique).
const ORGANIZATION_ERROR_MESSAGES: Record<string, string> = {
  SELF_MANAGEMENT_FORBIDDEN:
    "Un membre ne peut pas modifier sa propre membership.",
  OWNER_NOT_MANAGEABLE:
    "Le propriétaire ne peut pas être modifié depuis cet écran.",
  EMPTY_MEMBERSHIP_UPDATE: "Au moins un champ doit être modifié.",
  TRANSFER_TARGET_IS_CURRENT_OWNER:
    "Cette personne est déjà propriétaire de l'organisation.",
  TRANSFER_TARGET_NOT_ACTIVE:
    "La cible du transfert doit avoir une membership active.",
  MEMBER_ALREADY_ACTIVE:
    "Cet email appartient déjà à un membre actif de cette organisation.",
  INVITATION_ALREADY_PENDING:
    "Une invitation est déjà en attente pour cet email.",
  EMPTY_BRANDING_UPDATE: "Au moins un champ (nom, couleur, logo) est requis.",
  PERMISSION_DENIED: "Permission insuffisante pour cette action.",
};

export function describeOrganizationError(error: unknown): string {
  const code = getApiErrorCode(error);
  if (code && code in ORGANIZATION_ERROR_MESSAGES) {
    return ORGANIZATION_ERROR_MESSAGES[code];
  }
  return getApiErrorMessage(error);
}
