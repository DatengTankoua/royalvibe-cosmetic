"use client";

import { useState } from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  PASSWORD_HINT,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@/lib/password-policy";

interface NewPasswordFieldsProps {
  /** Préfixe des ids (`${idPrefix}password`, `${idPrefix}password-confirm`). */
  idPrefix: string;
  password: string;
  confirmation: string;
  onPasswordChange: (value: string) => void;
  onConfirmationChange: (value: string) => void;
  /** Id de l'erreur de formulaire à relier aux deux champs, si affichée. */
  errorId?: string;
  disabled?: boolean;
}

// 1-12G : mot de passe + confirmation (inscription publique, acceptation
// d'invitation). Un seul bouton afficher/masquer pilote les deux champs.
// Valeurs jamais trimées, jamais persistées : état React du parent seulement.
export function NewPasswordFields({
  idPrefix,
  password,
  confirmation,
  onPasswordChange,
  onConfirmationChange,
  errorId,
  disabled,
}: NewPasswordFieldsProps) {
  const [visible, setVisible] = useState(false);
  const passwordId = `${idPrefix}password`;
  const confirmId = `${idPrefix}password-confirm`;
  const hintId = `${passwordId}-hint`;
  const type = visible ? "text" : "password";

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={passwordId}>Mot de passe</Label>
        <div className="relative">
          <Input
            id={passwordId}
            type={type}
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            required
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            autoComplete="new-password"
            aria-describedby={errorId ? `${hintId} ${errorId}` : hintId}
            disabled={disabled}
            className="pr-9"
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-label={
              visible
                ? "Masquer les mots de passe"
                : "Afficher les mots de passe"
            }
            aria-pressed={visible}
            aria-controls={`${passwordId} ${confirmId}`}
            className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
          >
            {visible ? (
              <EyeOffIcon className="h-4 w-4" />
            ) : (
              <EyeIcon className="h-4 w-4" />
            )}
          </button>
        </div>
        <p id={hintId} className="text-xs text-muted-foreground">
          {PASSWORD_HINT}
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor={confirmId}>Confirmer le mot de passe</Label>
        <Input
          id={confirmId}
          type={type}
          value={confirmation}
          onChange={(e) => onConfirmationChange(e.target.value)}
          required
          maxLength={PASSWORD_MAX_LENGTH}
          autoComplete="new-password"
          aria-describedby={errorId}
          disabled={disabled}
        />
      </div>
    </>
  );
}
