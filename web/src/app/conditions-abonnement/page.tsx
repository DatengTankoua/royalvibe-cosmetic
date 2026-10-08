import { DocumentPage } from "@/components/legal/document-page";
import { documentMetadata } from "@/lib/legal/document-metadata";
import { legalDocument } from "@/lib/legal/site-identity";
import { getRequestLocale } from "@/i18n/server";
import en from "@/i18n/documents/conditions-abonnement/en";
import fr from "@/i18n/documents/conditions-abonnement/fr";

// 1-16G — Texte dans la langue de la requête : `i18n/documents/conditions-abonnement/`.
// Chaque langue publiée est archivée et vérifiée (`legal-archive.mjs`).
const CONTENT = { fr, en } as const;
const doc = legalDocument("/conditions-abonnement");

export async function generateMetadata() {
  const content = CONTENT[await getRequestLocale()];
  return documentMetadata(content.metaTitle, content.metaDescription, doc);
}

export default async function ConditionsAbonnementPage() {
  const content = CONTENT[await getRequestLocale()];
  return (
    <DocumentPage
      title={content.title}
      doc={doc}
      intro={content.intro}
      sections={content.sections}
    />
  );
}
