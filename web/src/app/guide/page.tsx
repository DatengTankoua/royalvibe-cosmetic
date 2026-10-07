import { DocumentPage } from "@/components/legal/document-page";
import { documentMetadata } from "@/lib/legal/document-metadata";
import { getRequestLocale } from "@/i18n/server";
import en from "@/i18n/documents/guide/en";
import fr from "@/i18n/documents/guide/fr";

// 1-16G — Texte dans la langue de la requête : `i18n/documents/guide/`.
const CONTENT = { fr, en } as const;

export async function generateMetadata() {
  const content = CONTENT[await getRequestLocale()];
  return documentMetadata(content.metaTitle, content.metaDescription);
}

export default async function GuidePage() {
  const content = CONTENT[await getRequestLocale()];
  return (
    <DocumentPage
      title={content.title}
      intro={content.intro}
      sections={content.sections}
    />
  );
}
