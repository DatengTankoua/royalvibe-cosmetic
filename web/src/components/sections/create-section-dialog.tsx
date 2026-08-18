"use client";

import { useState } from "react";
import axios from "axios";
import { PlusIcon } from "lucide-react";
import { toast } from "sonner";
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
  DuplicateWarningDialog,
  type DuplicateItem,
} from "@/components/ui/duplicate-warning-dialog";

interface CreateSectionDialogProps {
  onCreated: (name: string, description: string) => Promise<void>;
  label?: string;
}

export function CreateSectionDialog({
  onCreated,
  label,
}: CreateSectionDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [duplicate, setDuplicate] = useState<DuplicateItem | null>(null);

  const resetForm = () => {
    setName("");
    setDescription("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await onCreated(name, description);
      toast.success("Section créée");
      setOpen(false);
      resetForm();
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        const body = err.response.data as {
          message: string;
          existing: DuplicateItem;
        };
        if (body.message === "DUPLICATE_SECTION") {
          setOpen(false);
          setDuplicate(body.existing);
          return;
        }
      }
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <PlusIcon className="mr-1 h-4 w-4" />
        {label ?? "Nouvelle section"}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Créer une section</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label htmlFor="sec-name">Nom de la section</Label>
              <Input
                id="sec-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                placeholder="Ex: Parfums, Bijoux…"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sec-desc">Description (optionnel)</Label>
              <Textarea
                id="sec-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Création…" : "Créer"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <DuplicateWarningDialog
        type="section"
        item={duplicate}
        onClose={() => setDuplicate(null)}
      />
    </>
  );
}
