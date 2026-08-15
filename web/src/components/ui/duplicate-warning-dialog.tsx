"use client";

import { useRouter } from "next/navigation";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";

export interface DuplicateItem {
  _id: string;
  name: string;
  deletedAt: string | null;
  sectionId?: string;
}

interface DuplicateWarningDialogProps {
  type: "section" | "product";
  item: DuplicateItem | null;
  onClose: () => void;
}

export function DuplicateWarningDialog({
  type,
  item,
  onClose,
}: DuplicateWarningDialogProps) {
  const router = useRouter();

  const inTrash = !!item?.deletedAt;
  const label = type === "section" ? "catalogue" : "produit";

  const link = inTrash
    ? "/corbeille"
    : type === "section"
      ? `/sections/${item?._id}`
      : `/products/${item?._id}`;

  const handleView = () => {
    onClose();
    router.push(link);
  };

  return (
    <AlertDialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {type === "section"
              ? "Catalogue déjà existant"
              : "Produit déjà existant"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Un {label} nommé <strong>« {item?.name} »</strong> existe déjà
            {inTrash ? " dans la corbeille" : ""}.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>Fermer</AlertDialogCancel>
          <AlertDialogAction onClick={handleView}>
            {inTrash ? "Voir la corbeille" : `Voir le ${label}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
