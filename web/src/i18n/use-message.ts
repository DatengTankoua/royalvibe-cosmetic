"use client";

import { useCallback, useState } from "react";
import type { TFunction } from "i18next";
import { useT } from "next-i18next/client";
import type { Namespace } from "@/i18n/settings";

/**
 * 1-16G — Message gardé en état : soit une fonction de traduction (rendue
 * dans la langue COURANTE, donc à jour après un changement de langue), soit
 * un texte déjà traduit (message d'erreur renvoyé par l'API dans la langue
 * de la requête).
 */
export type MessageSource<N extends Namespace> =
  string | ((t: TFunction<N>) => string);

/** Texte d'un message dans la langue courante (toast, rendu direct). */
export function messageText<N extends Namespace>(
  source: MessageSource<N>,
  t: TFunction<N>,
): string {
  return typeof source === "function" ? source(t) : source;
}

export function useMessage<N extends Namespace>(ns: N) {
  const { t } = useT(ns);
  const [source, setSource] = useState<MessageSource<N> | null>(null);
  const set = useCallback(
    (next: MessageSource<N> | null) => setSource(() => next),
    [],
  );
  const text =
    source === null
      ? null
      : typeof source === "function"
        ? source(t as TFunction<N>)
        : source;
  return [text, set] as const;
}
