import Link from "next/link";
import Image from "next/image";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DeleteObjectButton } from "@/components/objects/delete-object-button";
import type { ApiObject } from "@/lib/api";

interface ObjectCardProps {
  object: ApiObject;
  onDeleted?: () => void;
}

export function ObjectCard({ object, onDeleted }: ObjectCardProps) {
  return (
    <Card>
      <Link
        href={`/objects/${object._id}`}
        className="relative block aspect-video w-full overflow-hidden bg-muted"
      >
        <Image
          src={object.imageUrl}
          alt={object.title}
          fill
          unoptimized
          className="object-cover"
        />
      </Link>
      <CardHeader>
        <CardTitle>
          <Link href={`/objects/${object._id}`} className="hover:underline">
            {object.title}
          </Link>
        </CardTitle>
        <CardDescription className="line-clamp-2">
          {object.description}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {formatDate(object.createdAt)}
        </span>
        <DeleteObjectButton
          id={object._id}
          title={object.title}
          onDeleted={onDeleted}
        />
      </CardContent>
    </Card>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
