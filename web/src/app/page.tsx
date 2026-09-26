import { redirect } from "next/navigation";

// "/" est libéré pour une future landing page publique (1-9D) — le catalogue
// vit désormais sous le shell authentifié (`/app/catalog`, seule
// implémentation). Redirection serveur, sans dépendre du JWT (localStorage) :
// `/app/*` applique déjà sa propre garde d'authentification.
export default function RootRedirect() {
  redirect("/app/catalog");
}
