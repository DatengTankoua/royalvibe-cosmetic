// Décodage LOCAL minimal d'un JWT déjà en localStorage (jamais persisté) :
// uniquement pour vérifier l'expiration avant un repli hors ligne — ne
// remplace jamais la vérification de signature côté serveur.
export function isJwtExpired(token: string): boolean {
  try {
    const payload = token.split(".")[1];
    if (!payload) return true;
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "===".slice((base64.length + 3) % 4);
    const json = JSON.parse(atob(padded)) as { exp?: unknown };
    if (typeof json.exp !== "number") return true;
    return Date.now() >= json.exp * 1000;
  } catch {
    return true;
  }
}
