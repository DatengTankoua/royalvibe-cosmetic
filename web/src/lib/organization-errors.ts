import { getApiErrorCode, getApiErrorMessage } from "@/lib/api";
import type { MessageSource } from "@/i18n/use-message";

// Codes métier stables renvoyés par l'API (organizations.service.ts) —
// traduits en messages utilisateur ; tout code inconnu retombe sur le
// message générique de `getApiErrorMessage` (jamais de détail technique).
// 1-16G : textes dans `organization` (`errors.<CODE>`).
const ORGANIZATION_ERROR_CODES = [
  "SELF_MANAGEMENT_FORBIDDEN",
  "OWNER_NOT_MANAGEABLE",
  "EMPTY_MEMBERSHIP_UPDATE",
  "TRANSFER_TARGET_IS_CURRENT_OWNER",
  "TRANSFER_TARGET_NOT_ACTIVE",
  "MEMBER_ALREADY_ACTIVE",
  "INVITATION_ALREADY_PENDING",
  "INVITATION_LINK_UNAVAILABLE",
  "EMPTY_BRANDING_UPDATE",
  "PERMISSION_DENIED",
] as const;

type OrganizationErrorCode = (typeof ORGANIZATION_ERROR_CODES)[number];

export function describeOrganizationError(
  error: unknown,
): MessageSource<"organization"> {
  const code = getApiErrorCode(error);
  if (code && (ORGANIZATION_ERROR_CODES as readonly string[]).includes(code)) {
    const known = code as OrganizationErrorCode;
    return (t) => t(`errors.${known}`);
  }
  return getApiErrorMessage(error);
}
