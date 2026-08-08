"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

export default function ObjectDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  useEffect(() => {
    router.replace(`/products/${params.id}`);
  }, [params.id, router]);

  return null;
}
