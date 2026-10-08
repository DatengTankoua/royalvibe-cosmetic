import { Fragment, type ReactNode } from "react";

// 1-16G — Mise en forme dans une phrase traduite : `<b>texte</b>` ou
// `<login>texte</login>` sont remplacés par le composant fourni sous ce nom.
// Un nom non fourni reste du texte brut ; aucun HTML n'est interprété.
// Utilisable côté serveur comme côté client. Les valeurs saisies par les
// utilisateurs ne doivent pas passer par ce gabarit (interpolation à part).
const TAG = /<([a-zA-Z][a-zA-Z0-9]*)>([\s\S]*?)<\/\1>/g;

export type RichComponents = Record<string, (chunk: string) => ReactNode>;

export function rich(text: string, components: RichComponents): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(TAG)) {
    const [whole, name, chunk] = match;
    const render = components[name];
    if (!render) continue;
    const start = match.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(<Fragment key={index++}>{render(chunk)}</Fragment>);
    last = start + whole.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 1 ? parts[0] : parts;
}
