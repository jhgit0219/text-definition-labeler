import ExcelJS from "exceljs";
import type { Entry } from "./db/schema";

const HEADERS = [
  "Text",
  "Gloss",
  "Page",
  "Edited?",
  "Multi-region?",
  "Snapped?",
  "Pred text (raw)",
  "Pred gloss (raw)",
];

/**
 * Build an in-memory xlsx workbook from a list of entries. Used by both
 * the per-page export endpoint and the all-pages export endpoint. The
 * caller is responsible for filtering (e.g. only state=='accepted').
 *
 * Returns a Buffer suitable for streaming back to the browser as a
 * Content-Disposition: attachment download.
 */
export async function buildXlsxBuffer(
  entries: Entry[],
  sheetTitle: string
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetTitle.slice(0, 31));
  ws.addRow(HEADERS);
  for (const e of entries) {
    ws.addRow([
      e.text,
      e.glossRaw,
      e.page,
      e.edited ? "yes" : "no",
      e.isMultiRegion ? "yes" : "no",
      e.snappedFrom ? "yes" : "no",
      e.predTextRaw ?? "",
      e.predGlossRaw ?? "",
    ]);
  }
  // Sensible column widths
  ws.getColumn(1).width = 16;
  ws.getColumn(2).width = 60;
  ws.getColumn(3).width = 6;
  ws.getColumn(4).width = 8;
  ws.getColumn(5).width = 12;
  ws.getColumn(6).width = 8;
  ws.getColumn(7).width = 18;
  ws.getColumn(8).width = 60;

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Heuristic OUV check used by the export filter. */
export function hasOUV(text: string): boolean {
  const t = (text || "").toLowerCase();
  return ["u", "o", "v", "ú", "ó"].some((c) => t.includes(c));
}
