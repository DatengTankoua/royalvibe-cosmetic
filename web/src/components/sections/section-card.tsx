"use client";

import Link from "next/link";
import { FolderIcon, Trash2Icon } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { ApiSection } from "@/lib/api";

interface SectionCardProps {
  section: ApiSection;
  isAdmin: boolean;
  onDelete: (id: string) => void;
}

export function SectionCard({ section, isAdmin, onDelete }: SectionCardProps) {
  return (
    <Card className="hover:shadow-md transition-shadow">
      <Link href={`/sections/${section._id}`} className="block">
        <CardHeader>
          <div className="flex items-center gap-2">
            <FolderIcon className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">{section.name}</CardTitle>
          </div>
          {section.description && (
            <CardDescription className="line-clamp-2">
              {section.description}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            {new Date(section.createdAt).toLocaleDateString("fr-FR")}
          </p>
        </CardContent>
      </Link>
      {isAdmin && (
        <div className="px-6 pb-4 flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => onDelete(section._id)}
          >
            <Trash2Icon className="h-4 w-4" />
          </Button>
        </div>
      )}
    </Card>
  );
}
