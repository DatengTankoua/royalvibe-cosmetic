/**
 * 1-15D / 1-15E — ordonnancement déterministe des courses dans les e2e.
 *
 * Une barrière est posée par espionnage d'une méthode existante (jamais de
 * crochet de test dans le code de production) ; aucune attente à durée fixe
 * n'ordonne une course.
 */

/** Barrière : `wait()` bloque jusqu'à `release()`. */
export function barrier() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return { wait: () => gate, release };
}

/** Attente d'une condition observable (jamais un délai fixe). */
export async function until(
  check: () => boolean,
  label: string,
): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 20_000) throw new Error(`Délai : ${label}`);
    await new Promise((r) => setImmediate(r));
  }
}
