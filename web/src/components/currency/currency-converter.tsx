"use client";

import { useState } from "react";
import { ArrowLeftRightIcon } from "lucide-react";
import { EUR_TO_XOF, fmtEur, fmtXof } from "@/lib/currency";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface CurrencyConverterProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function CurrencyConverter({
  open,
  onOpenChange,
}: CurrencyConverterProps) {
  const [eur, setEur] = useState("");
  const [xof, setXof] = useState("");

  const handleEurChange = (v: string) => {
    setEur(v);
    const n = parseFloat(v);
    setXof(isNaN(n) ? "" : String(Math.round(n * EUR_TO_XOF)));
  };

  const handleXofChange = (v: string) => {
    setXof(v);
    const n = parseFloat(v);
    setEur(isNaN(n) ? "" : (n / EUR_TO_XOF).toFixed(2));
  };

  const eurVal = parseFloat(eur);
  const xofVal = parseFloat(xof);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRightIcon className="h-4 w-4" />
            Convertisseur EUR ↔ Franc CFA
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          {/* EUR → XOF */}
          <div className="space-y-2">
            <Label htmlFor="eur-input">Euro (€)</Label>
            <Input
              id="eur-input"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={eur}
              onChange={(e) => handleEurChange(e.target.value)}
            />
            {!isNaN(eurVal) && eur !== "" && (
              <p className="text-sm text-muted-foreground">
                ={" "}
                <span className="font-semibold text-foreground">
                  {fmtXof(eurVal * EUR_TO_XOF)}
                </span>
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 text-muted-foreground">
            <div className="flex-1 h-px bg-border" />
            <ArrowLeftRightIcon className="h-4 w-4 shrink-0" />
            <div className="flex-1 h-px bg-border" />
          </div>

          {/* XOF → EUR */}
          <div className="space-y-2">
            <Label htmlFor="xof-input">Franc CFA (XOF)</Label>
            <Input
              id="xof-input"
              type="number"
              min="0"
              step="1"
              placeholder="0"
              value={xof}
              onChange={(e) => handleXofChange(e.target.value)}
            />
            {!isNaN(xofVal) && xof !== "" && (
              <p className="text-sm text-muted-foreground">
                ={" "}
                <span className="font-semibold text-foreground">
                  {fmtEur(xofVal / EUR_TO_XOF)}
                </span>
              </p>
            )}
          </div>

          <p className="text-xs text-muted-foreground border-t pt-3">
            Taux fixe officiel : 1 EUR = {EUR_TO_XOF.toFixed(3)} XOF
            <br />
            (Parité fixe FCFA zone UEMOA / Banque de France)
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
