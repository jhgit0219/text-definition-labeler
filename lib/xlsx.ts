import ExcelJS from "exceljs";
import type { Entry, EntryReconstructionPick } from "./db/schema";

const HEADERS = [
  "Text",
  "Gloss",
  "Page",
  "Edited?",
  "Multi-region?",
  "Snapped?",
  "Pred text (raw)",
  "Pred gloss (raw)",
  "Primary proto",
  "Alt protos",
  "Notes",
  "Pidnos",
];

/**
 * One entry's row in the export, with optional pick data attached.
 * `picks` may be empty for entries the annotator hasn't reconstructed yet —
 * the row still exports with blank reconstruction cells so the spreadsheet
 * doubles as a progress snapshot.
 */
export interface EntryForExport extends Entry {
  picks: Pick<EntryReconstructionPick, "pidno" | "protoForm" | "isPrimary">[];
}

/**
 * Build an in-memory xlsx workbook from a list of entries with their picks
 * attached. Used by both the per-page export endpoint and the all-pages
 * export endpoint. The caller is responsible for filtering rows (e.g. only
 * state=='accepted') and pre-joining picks.
 *
 * Returns a Buffer suitable for streaming back to the browser as a
 * Content-Disposition: attachment download.
 */
export async function buildXlsxBuffer(
  entries: EntryForExport[],
  sheetTitle: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetTitle.slice(0, 31));
  ws.addRow(HEADERS);
  for (const e of entries) {
    const primary = e.picks.find((p) => p.isPrimary);
    const alternates = e.picks.filter((p) => !p.isPrimary);
    ws.addRow([
      e.text,
      e.glossRaw,
      e.page,
      e.edited ? "yes" : "no",
      e.isMultiRegion ? "yes" : "no",
      e.snappedFrom ? "yes" : "no",
      e.predTextRaw ?? "",
      e.predGlossRaw ?? "",
      primary?.protoForm ?? "",
      alternates.map((p) => p.protoForm).join("; "),
      e.notes ?? "",
      e.picks.map((p) => p.pidno).join("; "),
    ]);
  }
  // Sensible column widths.
  ws.getColumn(1).width = 16; // Text
  ws.getColumn(2).width = 60; // Gloss
  ws.getColumn(3).width = 6; // Page
  ws.getColumn(4).width = 8; // Edited
  ws.getColumn(5).width = 12; // Multi-region
  ws.getColumn(6).width = 8; // Snapped
  ws.getColumn(7).width = 18; // Pred text
  ws.getColumn(8).width = 60; // Pred gloss
  ws.getColumn(9).width = 18; // Primary proto
  ws.getColumn(10).width = 24; // Alt protos
  ws.getColumn(11).width = 40; // Notes
  ws.getColumn(12).width = 16; // Pidnos

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Heuristic OUV check used by the export filter. */
export function hasOUV(text: string): boolean {
  const t = (text || "").toLowerCase();
  return ["u", "o", "v", "ú", "ó"].some((c) => t.includes(c));
}
