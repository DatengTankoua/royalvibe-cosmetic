"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/auth-context";
import Link from "next/link";
import Image from "next/image";

export default function RegisterPage() {
  const { register } = useAuth();
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  // 0B.5 : parcours d'inscription fermé — par défaut, un accès direct à la
  // route affiche un court message (affichage seulement ; le backend est
  // l'autorité finale et refuse déjà côté API).
  const registrationEnabled =
    process.env.NEXT_PUBLIC_REGISTRATION_ENABLED === "true";

  if (!registrationEnabled) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm space-y-4 text-center">
          <Image
            src="/logo.jpg"
            alt="RoyalVibe"
            width={64}
            height={64}
            className="mx-auto rounded-full object-cover shadow-md"
          />
          <h1 className="text-xl font-bold">Inscription désactivée</h1>
          <p className="text-sm text-muted-foreground">
            L&apos;inscription en ligne est momentanément indisponible. Si tu as
            déjà un compte, connecte-toi.
          </p>
          <Link
            href="/auth/login"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Se connecter
          </Link>
        </div>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await register(name, email, password);
      router.push("/");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Erreur d'inscription");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-3 text-center">
          <div className="flex justify-center">
            <Image
              src="/logo.jpg"
              alt="RoyalVibe"
              width={96}
              height={96}
              className="rounded-full object-cover shadow-md"
            />
          </div>
          <div>
            <h1 className="text-xl font-bold">
              RoyalVibe Cosmétiques &amp; Bijoux
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Créer un compte vendeur
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Prénom / Nom</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Mot de passe</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Inscription…" : "Créer mon compte"}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          Déjà un compte ?{" "}
          <Link href="/auth/login" className="underline">
            Se connecter
          </Link>
        </p>
      </div>
    </div>
  );
}
