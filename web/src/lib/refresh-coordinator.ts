// 1-15A — regroupement des relectures déclenchées par le temps réel.
//
// - Les demandes rapprochées (rafale d'événements) ouvrent UNE fenêtre de
//   `delayMs` : une seule relecture à son terme. La fenêtre n'est pas
//   repoussée par les demandes suivantes (aucune famine sous un flux continu).
// - Les relectures sont SÉRIALISÉES : jamais deux en parallèle. Une demande
//   arrivée PENDANT une relecture n'est pas perdue : elle en provoque une
//   nouvelle après la fin de la relecture en cours (la donnée relue a pu être
//   lue avant l'écriture qui a produit l'événement).
// - Aucune minuterie permanente : rien n'est planifié sans demande.
export interface RefreshCoordinator {
  request(): void;
  dispose(): void;
}

export function createRefreshCoordinator(
  run: () => Promise<unknown>,
  delayMs: number,
): RefreshCoordinator {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let dirty = false;
  let disposed = false;

  const start = () => {
    timer = null;
    if (disposed) return;
    running = true;
    dirty = false;
    void Promise.resolve()
      .then(run)
      .catch(() => {
        // L'appelant gère ses erreurs ; une relecture échouée ne bloque
        // jamais les suivantes.
      })
      .finally(() => {
        running = false;
        if (dirty && !disposed) {
          dirty = false;
          request();
        }
      });
  };

  function request() {
    if (disposed) return;
    if (running) {
      dirty = true;
      return;
    }
    if (timer) return;
    timer = setTimeout(start, delayMs);
  }

  return {
    request,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

// Ordre des réponses : une réponse n'est appliquée que si aucune réponse
// d'une requête PLUS RÉCENTE ne l'a déjà été (une réponse périmée arrivée en
// retard ne remplace jamais une donnée plus fraîche). Monotone : une requête
// plus ancienne arrivée la première reste appliquée.
export interface ResponseOrder {
  begin(): number;
  accept(ticket: number): boolean;
}

export function createResponseOrder(): ResponseOrder {
  let issued = 0;
  let applied = 0;
  return {
    begin: () => ++issued,
    accept(ticket) {
      if (ticket <= applied) return false;
      applied = ticket;
      return true;
    },
  };
}
