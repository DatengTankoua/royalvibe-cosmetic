// 1-14C.2 — Mémoire locale d'un REFUS COMMERCIAL connu.
//
// Dès que le serveur indique que l'abonnement de l'organisation n'est pas
// actif (contexte `access.applicationAccess === false` ou 403
// `SUBSCRIPTION_INACTIVE`), le refus est mémorisé pour CETTE identité
// (`userId` + `organizationId` issus du contexte serveur). Ni une coupure
// réseau ni un rechargement ne peuvent alors rouvrir l'interface métier à
// partir d'un ancien contexte local (repli hors ligne). Seule une nouvelle
// validation serveur positive pour la même identité l'efface.
//
// `localStorage`, aucune donnée sensible : deux identifiants, jamais de
// jeton. Une liste bornée permet plusieurs comptes/organisations.

const COMMERCIAL_BLOCK_KEY = "stockmaster_commercial_blocks";
const MAX_ENTRIES = 20;

interface BlockEntry {
  userId: string;
  organizationId: string;
  at: number;
}

function readAll(): BlockEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(COMMERCIAL_BLOCK_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter(
          (e): e is BlockEntry =>
            typeof e === "object" &&
            e !== null &&
            typeof (e as BlockEntry).userId === "string" &&
            typeof (e as BlockEntry).organizationId === "string",
        )
      : [];
  } catch {
    return [];
  }
}

function writeAll(entries: BlockEntry[]): void {
  try {
    window.localStorage.setItem(
      COMMERCIAL_BLOCK_KEY,
      JSON.stringify(entries.slice(-MAX_ENTRIES)),
    );
  } catch {
    // best effort : l'état React bloque déjà l'interface pour cet onglet.
  }
}

const same = (
  e: BlockEntry,
  identity: { userId: string; organizationId: string },
) =>
  e.userId === identity.userId && e.organizationId === identity.organizationId;

export function rememberCommercialBlock(identity: {
  userId: string;
  organizationId: string;
}): void {
  const others = readAll().filter((e) => !same(e, identity));
  writeAll([...others, { ...identity, at: Date.now() }]);
}

export function isCommerciallyBlocked(identity: {
  userId: string;
  organizationId: string;
}): boolean {
  return readAll().some((e) => same(e, identity));
}

/** Uniquement après une validation SERVEUR positive pour cette identité. */
export function forgetCommercialBlock(identity: {
  userId: string;
  organizationId: string;
}): void {
  const entries = readAll();
  const kept = entries.filter((e) => !same(e, identity));
  if (kept.length !== entries.length) writeAll(kept);
}
