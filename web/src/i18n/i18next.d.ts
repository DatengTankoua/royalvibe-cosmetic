import "i18next";
import type { resourcesFr } from "@/i18n/resources";

// 1-16G — Clés de traduction vérifiées à la compilation : `t("x.y")` sur une
// clé absente du français est une erreur TypeScript. L'anglais a la même
// forme (type `Translation`).
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: typeof resourcesFr;
    returnNull: false;
  }
}
