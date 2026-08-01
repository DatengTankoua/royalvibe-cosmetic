"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DeleteObjectButton } from "@/components/objects/delete-object-button";
import { fetchObject, getApiErrorMessage, type ApiObject } from "@/lib/api";

export default function ObjectDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [object, setObject] = useState<ApiObject | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets stale state before refetching when params.id changes
    setIsLoading(true);
    setError(null);

    fetchObject(params.id)
      .then((data) => {
        if (!cancelled) setObject(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(getApiErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [params.id]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => router.push("/")}
        className="w-fit"
      >
        <ArrowLeftIcon />
        Back to objects
      </Button>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {!isLoading && error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {!isLoading && !error && object && (
        <div className="flex flex-col gap-4">
          <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-muted">
            <Image
              src={object.imageUrl}
              alt={object.title}
              fill
              unoptimized
              className="object-cover"
            />
          </div>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold">{object.title}</h1>
              <p className="text-xs text-muted-foreground">
                Created {new Date(object.createdAt).toLocaleString()}
              </p>
            </div>
            <DeleteObjectButton
              id={object._id}
              title={object.title}
              onDeleted={() => router.push("/")}
            />
          </div>
          <p className="text-sm whitespace-pre-line text-foreground">
            {object.description}
          </p>
        </div>
      )}
    </div>
  );
}
