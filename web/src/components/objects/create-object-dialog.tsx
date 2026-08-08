"use client";

import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import Image from "next/image";
import { toast } from "sonner";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { getApiErrorMessage } from "@/lib/api";

export function CreateObjectDialog() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function resetForm() {
    setTitle("");
    setDescription("");
    setImageFile(null);
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setImageFile(file);
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return file ? URL.createObjectURL(file) : null;
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!imageFile) {
      toast.error("Please select an image");
      return;
    }

    setIsSubmitting(true);
    try {
      // Legacy stub — product creation now handled via CreateProductDialog
      toast.info("Utilise la page Sections pour créer des produits");
      resetForm();
      setOpen(false);
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen: boolean) => {
        setOpen(nextOpen);
        if (!nextOpen) resetForm();
      }}
    >
      <DialogTrigger render={<Button />}>
        <PlusIcon />
        New object
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a new object</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="image">Image</Label>
            <Input
              id="image"
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              required
            />
            {previewUrl && (
              <Image
                src={previewUrl}
                alt="Preview"
                width={400}
                height={300}
                className="mt-2 h-40 w-full rounded-lg object-cover"
              />
            )}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
