import type { Metadata } from "next";
import { SITE, type PublicDocument } from "./site-identity";

// 1-16C — Métadonnées des pages publiques. Un document à l'état de projet
// n'est pas proposé à l'indexation (`noindex`) : il reste consultable par
// lien, mais n'apparaît pas comme texte de référence dans les moteurs.
export function documentMetadata(
  title: string,
  description: string,
  doc?: PublicDocument,
): Metadata {
  const draft = doc?.status === "projet";
  return {
    title: `${title} — ${SITE.name}`,
    description,
    ...(draft ? { robots: { index: false, follow: true } } : {}),
  };
}
