"use client";

import { useObjects } from "@/hooks/use-objects";
import { ObjectCard } from "@/components/objects/object-card";
import { CreateObjectDialog } from "@/components/objects/create-object-dialog";

export default function Home() {
  const { objects, isLoading, error, removeLocal } = useObjects();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Objects</h1>
        <CreateObjectDialog />
      </div>

      {isLoading && (
        <p className="text-sm text-muted-foreground">Loading objects…</p>
      )}

      {!isLoading && error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {!isLoading && !error && objects.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No objects yet. Create the first one.
        </p>
      )}

      {!isLoading && !error && objects.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {objects.map((object) => (
            <ObjectCard
              key={object._id}
              object={object}
              onDeleted={() => removeLocal(object._id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
