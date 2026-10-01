import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";

// Retour vers la page publique depuis les pages d'authentification. Zone de
// clic confortable (≥ 44 px de haut) et focus visible au clavier.
export function BackToHome() {
  return (
    <div className="flex justify-start">
      <Link
        href="/"
        className="-ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <ArrowLeftIcon className="h-4 w-4" aria-hidden />
        Retour à l&apos;accueil
      </Link>
    </div>
  );
}
