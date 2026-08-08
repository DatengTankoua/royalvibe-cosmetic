import Link from "next/link";
import Image from "next/image";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ApiProduct } from "@/lib/api";

interface ObjectCardProps {
  object: ApiProduct;
  onDeleted?: () => void;
}

export function ObjectCard({ object }: ObjectCardProps) {
  return (
    <Card>
      <Link
        href={`/products/${object._id}`}
        className="relative block aspect-video w-full overflow-hidden bg-muted"
      >
        <Image
          src={object.imageUrl}
          alt={object.name}
          fill
          unoptimized
          className="object-cover"
        />
      </Link>
      <CardHeader>
        <CardTitle>
          <Link href={`/products/${object._id}`} className="hover:underline">
            {object.name}
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent />
    </Card>
  );
}
