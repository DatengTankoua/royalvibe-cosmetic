"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";
import { useSections } from "@/hooks/use-sections";
import { SectionCard } from "@/components/sections/section-card";
import { CreateSectionDialog } from "@/components/sections/create-section-dialog";
import { useAuth } from "@/contexts/auth-context";

export default function Home() {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const { sections, isLoading, error, addSection, removeSection } =
    useSections();

  useEffect(() => {
    if (!authLoading && !user) router.push("/auth/login");
  }, [user, authLoading, router]);

  if (authLoading || !user) return null;

  const handleDelete = async (id: string) => {
    try {
      await removeSection(id);
      toast.success("Section supprimée");
    } catch {
      toast.error("Impossible de supprimer la section");
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Catalogue</h1>
          <p className="text-sm text-muted-foreground">
            Sélectionne une catégorie pour voir les produits
          </p>
        </div>
        {user.role === "admin" && (
          <CreateSectionDialog
            onCreated={async (name, description) => {
              await addSection(name, description);
            }}
          />
        )}
      </div>

      {isLoading && (
        <p className="text-sm text-muted-foreground">Chargement…</p>
      )}
      {!isLoading && error && (
        <p className="text-sm text-destructive">{error}</p>
      )}
      {!isLoading && !error && sections.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Aucune section.{" "}
          {user.role === "admin" && "Crée la première section ci-dessus."}
        </p>
      )}
      {!isLoading && !error && sections.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sections.map((s) => (
            <SectionCard
              key={s._id}
              section={s}
              isAdmin={user.role === "admin"}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
