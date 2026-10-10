// 1-20D — Relecture CIBLÉE d'une liste de produits après les ventes.
//
// Une vente ne change que les produits qu'elle concerne : la liste relit
// ces seuls produits (`GET /products?ids=…`, même projection que la liste,
// selon les permissions du demandeur) au lieu de la liste complète. Le
// serveur reste la source de vérité : aucun « stock − quantité » local.
//
// Ordre des réponses, PAR PRODUIT : chaque requête (complète ou ciblée)
// reçoit un ticket croissant ; une réponse n'est appliquée à un produit que
// si aucune réponse d'une requête plus récente ne l'a déjà été pour lui. Une
// relecture complète plus ancienne qu'une relecture ciblée n'écrase donc ni
// le produit relu, ni sa disparition.

/** Au-delà, une relecture complète est moins coûteuse et plus simple. */
export const TARGETED_REFRESH_MAX_IDS = 50;

interface Identified {
  _id: string;
}

export interface CatalogFreshness {
  begin(): number;
  /**
   * Liste complète de la requête `ticket` ; `null` si elle est périmée
   * (une liste complète plus récente est déjà appliquée).
   */
  applyFull<T extends Identified>(
    ticket: number,
    current: readonly T[],
    incoming: readonly T[],
  ): T[] | null;
  /**
   * Relecture ciblée : remplace chaque produit demandé ENCORE affiché par
   * sa version serveur, retire ceux que le serveur ne renvoie plus (corbeille,
   * autre rayon, plus visibles). Jamais d'insertion (seuls des produits
   * affichés sont demandés). Ignore les produits non demandés (une API
   * antérieure renvoie toute la liste).
   */
  applyTargeted<T extends Identified>(
    ticket: number,
    current: readonly T[],
    requested: readonly string[],
    incoming: readonly T[],
  ): { next: T[]; applied: string[] };
}

export function createCatalogFreshness(): CatalogFreshness {
  let issued = 0;
  let fullApplied = 0;
  // Dernier ticket appliqué par produit (relecture ciblée) et produits que
  // ce ticket a retirés.
  const perProduct = new Map<string, { ticket: number; removed: boolean }>();

  return {
    begin: () => ++issued,

    applyFull(ticket, current, incoming) {
      if (ticket <= fullApplied) return null;
      fullApplied = ticket;
      const fresher = new Map<string, Identified>();
      const removed = new Set<string>();
      for (const [id, entry] of perProduct) {
        if (entry.ticket <= ticket) {
          perProduct.delete(id);
        } else if (entry.removed) {
          removed.add(id);
        }
      }
      for (const p of current) {
        const entry = perProduct.get(p._id);
        if (entry && !entry.removed) fresher.set(p._id, p);
      }
      const next = incoming
        .filter((p) => !removed.has(p._id))
        .map((p) => (fresher.get(p._id) as typeof p | undefined) ?? p);
      // Produit relu plus récemment et absent de cette liste plus ancienne.
      for (const [id, p] of fresher) {
        if (!next.some((x) => x._id === id)) next.push(p as (typeof next)[0]);
      }
      return next;
    },

    applyTargeted(ticket, current, requested, incoming) {
      const wanted = new Set(requested);
      const byId = new Map(
        incoming.filter((p) => wanted.has(p._id)).map((p) => [p._id, p]),
      );
      let next = [...current];
      const applied: string[] = [];
      for (const id of wanted) {
        const entry = perProduct.get(id);
        if (ticket <= fullApplied || (entry && ticket <= entry.ticket)) {
          continue;
        }
        const fresh = byId.get(id);
        const index = next.findIndex((x) => x._id === id);
        if (index < 0) continue; // retiré entre-temps : jamais réinséré
        perProduct.set(id, { ticket, removed: !fresh });
        applied.push(id);
        next =
          fresh !== undefined
            ? next.map((x, i) => (i === index ? fresh : x))
            : next.filter((_, i) => i !== index);
      }
      return { next, applied };
    },
  };
}

/**
 * Relecture à lancer au moment où elle part (après regroupement) : complète
 * si demandée (signal produit, photo, rattrapage), si aucun produit n'est
 * désigné ou s'ils sont trop nombreux ; sinon ciblée, sans doublon.
 */
export function planRefresh(
  pendingIds: Iterable<string>,
  fullRequested: boolean,
): { kind: "full" } | { kind: "targeted"; ids: string[] } {
  const ids = [...new Set(pendingIds)];
  if (
    fullRequested ||
    ids.length === 0 ||
    ids.length > TARGETED_REFRESH_MAX_IDS
  ) {
    return { kind: "full" };
  }
  return { kind: "targeted", ids };
}
