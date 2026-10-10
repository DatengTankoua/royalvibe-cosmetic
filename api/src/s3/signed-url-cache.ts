/**
 * 1-20C — Réutilisation BORNÉE des URL GET signées (mémoire du processus).
 *
 * Une URL signée est réutilisée pour la même clé de cache pendant au plus
 * `reuseMs` après sa signature, puis signée de nouveau. Chaque URL délivrée
 * garde donc au moins `validité − reuseMs` de durée restante.
 *
 * - Capacité bornée : au-delà de `maxEntries`, l'entrée la moins récemment
 *   utilisée est évincée (ordre d'insertion de `Map`, rafraîchi à chaque
 *   lecture).
 * - Calculs simultanés mutualisés : une seule signature en cours par clé.
 * - Aucune erreur ni absence (`null`) mise en cache : l'entrée en cours est
 *   libérée et l'appel suivant recalcule.
 * - Ne fait AUCUN contrôle d'accès : l'appelant vérifie stockage et
 *   périmètre AVANT de consulter le cache.
 * - Ne révoque pas une URL déjà délivrée : elle reste valable jusqu'à son
 *   expiration, comme sans cache.
 */
export class SignedUrlCache {
  private readonly entries = new Map<
    string,
    { url: string; reusableUntil: number }
  >();
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(
    private readonly options: {
      maxEntries: number;
      reuseMs: number;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * URL réutilisable pour `key`, sinon `sign()` (une seule fois pour des
   * appels simultanés). `sign` renvoie `null` ou lève en cas d'échec : rien
   * n'est alors conservé.
   */
  async get(
    key: string,
    sign: () => Promise<string | null>,
  ): Promise<string | null> {
    const cached = this.entries.get(key);
    if (cached) {
      if (cached.reusableUntil > this.now()) {
        // Rafraîchit la position LRU.
        this.entries.delete(key);
        this.entries.set(key, cached);
        return cached.url;
      }
      this.entries.delete(key);
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const signedAt = this.now();
    const job = (async () => {
      try {
        const url = await sign();
        if (url !== null && this.options.reuseMs > 0) {
          this.entries.set(key, {
            url,
            reusableUntil: signedAt + this.options.reuseMs,
          });
          while (this.entries.size > this.options.maxEntries) {
            const oldest = this.entries.keys().next().value as string;
            this.entries.delete(oldest);
          }
        }
        return url;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, job);
    return job;
  }
}
