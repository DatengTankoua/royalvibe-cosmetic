"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ImageOffIcon } from "lucide-react";
import { requestImageRenewal } from "@/lib/image-renewal";

// R2 privé — photo produit chargée par un lien signé à durée limitée.
// Lien absent, invalide ou image non chargeable (lien expiré, fichier
// absent, stockage indisponible) → image de remplacement, jamais d'image
// cassée, et demande BORNÉE de liens neufs (`requestImageRenewal`). L'échec
// est mémorisé PAR LIEN : un nouveau lien (relecture, photo remplacée,
// changement d'organisation) retente le chargement. Aucun cache persistant.

function safeImageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function StoredImage({
  src,
  alt,
  priority = false,
  lazy = true,
  className = "object-cover",
}: {
  src: string | null | undefined;
  alt: string;
  priority?: boolean;
  lazy?: boolean;
  className?: string;
}) {
  const safe = safeImageUrl(src);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const showImage = safe !== null && failedSrc !== safe;

  // Erreur survenue avant l'attachement du gestionnaire React.
  useEffect(() => {
    const img = imgRef.current;
    if (showImage && img && img.complete && img.naturalWidth === 0) {
      setFailedSrc(safe);
      requestImageRenewal(safe);
    }
  }, [showImage, safe]);

  if (!showImage) {
    return (
      <span
        role="img"
        aria-label={alt}
        data-stored-image="placeholder"
        className="absolute inset-0 flex items-center justify-center bg-muted text-muted-foreground"
      >
        <ImageOffIcon className="h-8 w-8" aria-hidden />
      </span>
    );
  }

  return (
    <Image
      ref={imgRef}
      src={safe}
      alt={alt}
      fill
      unoptimized
      priority={priority}
      loading={priority ? "eager" : lazy ? "lazy" : undefined}
      data-stored-image="image"
      onError={() => {
        setFailedSrc(safe);
        requestImageRenewal(safe);
      }}
      className={className}
    />
  );
}
