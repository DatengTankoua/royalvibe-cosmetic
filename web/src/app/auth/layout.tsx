import { ThemeToggle } from "@/components/theme/theme-toggle";

// 1-16F — Parcours de connexion, inscription, invitation, mot de passe et
// confirmation d'email : pas d'en-tête de navigation, seulement le contrôle
// du thème en haut à droite. Aucun état ni appel réseau ajouté ; les
// layouts enfants (métadonnées, rendu dynamique) restent inchangés.
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex justify-end px-3 pt-3">
        <ThemeToggle />
      </div>
      {children}
    </div>
  );
}
