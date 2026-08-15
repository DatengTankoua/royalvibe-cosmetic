"use client";

import { useState } from "react";
import axios from "axios";
import Link from "next/link";
import { FolderIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import {
  DuplicateWarningDialog,
  type DuplicateItem,
} from "@/components/ui/duplicate-warning-dialog";
import type { ApiSection } from "@/lib/api";

interface SectionCardProps {
  section: ApiSection;
  isAdmin: boolean;
  onDelete: (id: string) => void;
  onRename?: (id: string, name: string, description: string) => Promise<void>;
}

export function SectionCard({
  section,
  isAdmin,
  onDelete,
  onRename,
}: SectionCardProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameLoading, setRenameLoading] = useState(false);
  const [newName, setNewName] = useState(section.name);
  const [newDesc, setNewDesc] = useState(section.description ?? "");
  const [duplicate, setDuplicate] = useState<DuplicateItem | null>(null);

  const handleRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onRename) return;
    setRenameLoading(true);
    try {
      await onRename(section._id, newName, newDesc);
      toast.success("Catalogue renommé");
      setRenameOpen(false);
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        const body = err.response.data as {
          message: string;
          existing: DuplicateItem;
        };
        if (body.message === "DUPLICATE_SECTION") {
          setRenameOpen(false);
          setDuplicate(body.existing);
          return;
        }
      }
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setRenameLoading(false);
    }
  };

  return (
    <>
      <Card className="hover:shadow-md transition-shadow">
        <Link href={`/sections/${section._id}`} className="block">
          <CardHeader>
            <div className="flex items-center gap-2">
              <FolderIcon className="h-5 w-5 shrink-0 text-muted-foreground" />
              <CardTitle className="text-base truncate">
                {section.name}
              </CardTitle>
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
          <div className="px-6 pb-4 flex justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setNewName(section.name);
                setNewDesc(section.description ?? "");
                setRenameOpen(true);
              }}
            >
              <PencilIcon className="h-4 w-4" />
            </Button>
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

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Renommer le catalogue</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleRename} className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label htmlFor={`rename-${section._id}`}>Nouveau nom</Label>
              <Input
                id={`rename-${section._id}`}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`desc-${section._id}`}>Description</Label>
              <Textarea
                id={`desc-${section._id}`}
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                rows={2}
              />
            </div>
            <Button type="submit" className="w-full" disabled={renameLoading}>
              {renameLoading ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

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

      <DuplicateWarningDialog
        type="section"
        item={duplicate}
        onClose={() => setDuplicate(null)}
      />
    </>
  );
}
