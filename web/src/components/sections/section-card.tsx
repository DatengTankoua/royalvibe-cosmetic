"use client";

import { useState } from "react";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { ApiSection } from "@/lib/api";

interface SectionCardProps {
  section: ApiSection;
  isAdmin: boolean;
  onDelete: (id: string) => void;
}

export function SectionCard({ section, isAdmin, onDelete }: SectionCardProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <>
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
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2Icon className="h-4 w-4" />
            </Button>
          </div>
        )}
      </Card>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Déplacer ce catalogue à la corbeille ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Le catalogue <strong>{section.name}</strong> sera déplacé dans la
              corbeille. Tu pourras le restaurer depuis la page Corbeille.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setConfirmDelete(false);
                onDelete(section._id);
              }}
            >
              Mettre à la corbeille
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
