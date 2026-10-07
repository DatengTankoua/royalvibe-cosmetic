import type { DocumentSection } from "@/components/legal/document-page";

// 1-16G — Contenu d'une page longue (document juridique, guide, contact)
// dans UNE langue. Un module par document et par langue :
// `i18n/documents/<page>/<langue>.tsx`. Les identifiants de sections
// (ancres) sont les mêmes dans toutes les langues.
export interface DocumentContent {
  metaTitle: string;
  metaDescription: string;
  title: string;
  intro: React.ReactNode;
  sections: DocumentSection[];
}
