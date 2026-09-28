import type { OutboxOperation } from "./offline-sales-outbox-db";

// 1-11C.3 — Export LOCAL des ventes non finalisées (JSON / CSV).
// Téléchargement navigateur uniquement, n'efface rien. Contient
// potentiellement nom/contact acheteur ; jamais de token, d'empreinte ni de
// champ technique de verrou.

export interface ExportedSale {
  clientOperationId: string;
  organizationId: string;
  status: string;
  productId: string;
  productName: string;
  quantity: number;
  salePrice: number;
  buyerName: string;
  buyerContact: string;
  occurredAt: string;
  createdAt: string;
  attempts: number;
  lastErrorCode: string;
}

const COLUMNS: (keyof ExportedSale)[] = [
  "clientOperationId",
  "organizationId",
  "status",
  "productId",
  "productName",
  "quantity",
  "salePrice",
  "buyerName",
  "buyerContact",
  "occurredAt",
  "createdAt",
  "attempts",
  "lastErrorCode",
];

export function toExportedSales(
  ops: readonly OutboxOperation[],
): ExportedSale[] {
  return ops.map((op) => ({
    clientOperationId: op.clientOperationId,
    organizationId: op.organizationId,
    status: op.status,
    productId: op.payload.productId,
    productName: op.display.productName,
    quantity: op.payload.quantity,
    salePrice: op.payload.salePrice,
    buyerName: op.payload.buyerName ?? "",
    buyerContact: op.payload.buyerContact ?? "",
    occurredAt: op.payload.occurredAt,
    createdAt: new Date(op.createdAt).toISOString(),
    attempts: op.attempts,
    lastErrorCode: op.lastError?.code ?? op.lastError?.kind ?? "",
  }));
}

export function toExportJson(ops: readonly OutboxOperation[]): string {
  return JSON.stringify(
    { exportedAt: new Date().toISOString(), sales: toExportedSales(ops) },
    null,
    2,
  );
}

// Anti formula-injection : une cellule commençant par = + - @ (ou tab/CR,
// interprétables par certains tableurs) est préfixée d'une apostrophe, puis
// toujours mise entre guillemets (guillemets internes doublés).
export function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toExportCsv(ops: readonly OutboxOperation[]): string {
  const rows = toExportedSales(ops).map((sale) =>
    COLUMNS.map((column) => csvCell(sale[column])).join(","),
  );
  // BOM UTF-8 : accents lisibles dans les tableurs.
  return `﻿${[COLUMNS.map(csvCell).join(","), ...rows].join("\r\n")}\r\n`;
}

export function downloadTextFile(
  filename: string,
  content: string,
  mimeType: string,
): void {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportFilename(extension: "json" | "csv"): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return `ventes-en-attente-${stamp}.${extension}`;
}

export function downloadSalesExport(
  ops: readonly OutboxOperation[],
  format: "json" | "csv",
): void {
  if (format === "json") {
    downloadTextFile(
      exportFilename("json"),
      toExportJson(ops),
      "application/json;charset=utf-8",
    );
  } else {
    downloadTextFile(
      exportFilename("csv"),
      toExportCsv(ops),
      "text/csv;charset=utf-8",
    );
  }
}
