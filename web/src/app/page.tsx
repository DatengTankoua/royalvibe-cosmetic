"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { useSections } from "@/hooks/use-sections";
import { SectionCard } from "@/components/sections/section-card";
import { CreateSectionDialog } from "@/components/sections/create-section-dialog";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/auth-context";

export default function Home() {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const {
    sections,
    isLoading,
    error,
    reload,
    addSection,
    removeSection,
    renameSection,
  } = useSections();

  const filtered = useMemo(
    () =>
      query.trim()
        ? sections.filter((s) =>
            s.name.toLowerCase().includes(query.toLowerCase()),
          )
        : sections,
    [sections, query],
  );

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

  const handleRename = async (
    id: string,
    name: string,
    description: string,
  ) => {
    await renameSection(id, name, description);
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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

      {/* Search bar */}
      <div className="relative">
        <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Rechercher un catalogue…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {isLoading && (
        <p className="text-sm text-muted-foreground">Chargement…</p>
      )}
      {!isLoading && error && (
        <div className="flex items-center gap-3">
          <p className="text-sm text-destructive">{error}</p>
          <button
            onClick={() => void reload()}
            className="text-sm text-primary underline underline-offset-2 hover:no-underline"
          >
            Réessayer
          </button>
        </div>
      )}
      {!isLoading && !error && sections.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Aucune section.{" "}
          {user.role === "admin" && "Crée la première section ci-dessus."}
        </p>
      )}
      {!isLoading && !error && sections.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Aucun résultat pour « {query} ».
        </p>
      )}
      {!isLoading && !error && filtered.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((s) => (
            <SectionCard
              key={s._id}
              section={s}
              isAdmin={user.role === "admin"}
              onDelete={handleDelete}
              onRename={user.role === "admin" ? handleRename : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}
