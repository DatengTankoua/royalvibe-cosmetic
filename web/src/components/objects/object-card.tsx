import Link from "next/link";
import { StoredImage } from "@/components/products/stored-image";
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
        prefetch={false}
        href={`/app/catalog/products/${object._id}`}
        className="relative block aspect-video w-full overflow-hidden bg-muted"
      >
        <StoredImage src={object.imageUrl} alt={object.name} />
      </Link>
      <CardHeader>
        <CardTitle>
          <Link
            prefetch={false}
            href={`/app/catalog/products/${object._id}`}
            className="hover:underline"
          >
            {object.name}
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent />
    </Card>
  );
}
