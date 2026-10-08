// 1-16G — Forme attendue d'une traduction : mêmes clés que le français, au
// même niveau, toutes en texte. Seule la forme plurielle française `_many`
// (1 000 000…) n'existe pas en anglais. Une clé anglaise manquante ou en
// trop est une erreur de typage ; les variables `{{…}}`, les balises `<…>`
// et les pluriels sont vérifiés par `web/scripts/check-i18n.mjs`.
export type Translation<T> = {
  [K in keyof T as K extends `${string}_many` ? never : K]: T[K] extends string
    ? string
    : Translation<T[K]>;
};
