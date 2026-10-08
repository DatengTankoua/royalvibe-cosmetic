"use client";

import { useRouter } from "next/navigation";
import { useT } from "next-i18next/client";
import { rich } from "@/i18n/rich";
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
  const { t } = useT("catalog");
  const router = useRouter();

  const inTrash = !!item?.deletedAt;

  const link = inTrash
    ? "/app/trash"
    : type === "section"
      ? `/app/catalog/${item?._id}`
      : `/app/catalog/products/${item?._id}`;

  const handleView = () => {
    onClose();
    router.push(link);
  };

  return (
    <AlertDialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(`duplicate.${type}.title`)}</AlertDialogTitle>
          <AlertDialogDescription>
            {/* Nom saisi par l'utilisateur : inséré à part, jamais dans le
                gabarit interprété. */}
            {rich(
              t(
                inTrash
                  ? `duplicate.${type}.existsInTrash`
                  : `duplicate.${type}.exists`,
              ),
              { name: () => <strong>« {item?.name} »</strong> },
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>
            {t("actions.close")}
          </AlertDialogCancel>
          <AlertDialogAction onClick={handleView}>
            {inTrash ? t("duplicate.viewTrash") : t(`duplicate.${type}.view`)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
