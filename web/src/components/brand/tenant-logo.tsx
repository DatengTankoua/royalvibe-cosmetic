"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { StoreIcon } from "lucide-react";
import { organizationInitials } from "@/lib/display-names";

// 1-12A — Logo du commerce dans le shell /app : cadre FIXE, image en
// `object-contain` (jamais étirée ni rognée), repli sur les initiales sur
// fond `--tenant-accent` si le logo est absent, non chargeable (hors ligne,
// URL expirée) ou invalide — jamais d'image cassée. Ne reçoit que `logoUrl`
// fourni par l'API, jamais `logoKey`.

const SIZES = {
  sm: { box: "h-9 w-9", text: "text-sm", icon: "h-4 w-4", px: 36 },
  lg: { box: "h-20 w-20", text: "text-2xl", icon: "h-8 w-8", px: 80 },
} as const;

function safeLogoUrl(value: string | null | undefined): string | null {
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

export function TenantLogo({
  name,
  logoUrl,
  size = "sm",
}: {
  name: string | null;
  logoUrl: string | null | undefined;
  size?: keyof typeof SIZES;
}) {
  const s = SIZES[size];
  const src = safeLogoUrl(logoUrl);
  // Échec mémorisé PAR URL : une nouvelle URL (branding modifié, retour en
  // ligne) retente le chargement.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const showImage = src !== null && failedSrc !== src;

  // Erreur survenue avant l'attachement du gestionnaire React.
  useEffect(() => {
    const img = imgRef.current;
    if (showImage && img && img.complete && img.naturalWidth === 0) {
      setFailedSrc(src);
    }
  }, [showImage, src]);

  if (showImage) {
    return (
      <span
        className={`${s.box} flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-(--tenant-accent-border) bg-white p-0.5`}
        data-tenant-logo="image"
      >
        <Image
          ref={imgRef}
          src={src}
          alt=""
          width={s.px}
          height={s.px}
          unoptimized
          onError={() => setFailedSrc(src)}
          className="h-full w-full object-contain"
        />
      </span>
    );
  }

  const initials = organizationInitials(name);
  return (
    <span
      aria-hidden="true"
      className={`${s.box} ${s.text} flex shrink-0 select-none items-center justify-center rounded-md border border-black/10 bg-(--tenant-accent) font-semibold leading-none text-(--tenant-accent-foreground)`}
      data-tenant-logo="initials"
    >
      {initials || <StoreIcon className={s.icon} />}
    </span>
  );
}
