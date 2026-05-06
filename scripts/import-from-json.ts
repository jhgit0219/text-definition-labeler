/**
 * One-shot importer: read OCR-Cursive-Scanner's Gemini output and upsert every
 * entry into the Postgres `entries` table.
 *
 * Source files (relative to this repo's parent dir):
 *   ../OCR-Cursive-Scanner/output/gemini/results_pNNN.json
 *
 * (Legacy per-page-subdir layout `output/page_NNN_gemini/results.json` is also
 * supported as a fallback for old runs.)
 *
 * Gemini's output is bbox-free — entries are listed in reading order. We use
 * the array index as `entry_idx`, which keeps ON CONFLICT(page, entry_idx)
 * idempotent: re-running the import with updated Gemini results just
 * overwrites the prior row.
 *
 * Run:
 *   npm run import
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { db, schema } from "../lib/db";
import { sql } from "drizzle-orm";

const SCANNER_OUTPUT_DIR = resolve(
  process.cwd(),
  "..",
  "OCR-Cursive-Scanner",
  "output"
);
const GEMINI_DIR = join(SCANNER_OUTPUT_DIR, "gemini");

type GeminiEntry = {
  text: string;
  gloss: string;
  // Optional provenance fields, present when post-processing fired.
  text_pre_snap?: string | null;
  snap_edit_distance?: number | null;
  text_pre_alphabet_fix?: string | null;
  alphabet_fix_edit_distance?: number | null;
};

type GeminiPageResults = {
  page: number;
  method: string;
  n_entries: number;
  generation_seconds?: number;
  wall_seconds?: number;
  exemplars_used?: number;
  entries: GeminiEntry[];
};

/** Split "Curtir. Ceniza." into ["Curtir", "Ceniza"]. Trims periods + whitespace. */
function splitGlossString(s: string): string[] {
  if (!s) return [];
  return s
    .split(/\.\s+|\s*\.\s*$/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Read JSON, returning null if the file is missing. Strips a leading UTF-8 BOM
 * if present (the OCR-Cursive-Scanner pipeline writes files with BOM so they
 * auto-detect as UTF-8 in Windows editors). */
async function readJsonOrNull<T = unknown>(path: string): Promise<T | null> {
  try {
    let raw = await readFile(path, "utf-8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** What the model originally said, before any post-processing rewrote it.
 *  Priority: alphabet-guard pre-fix > snap pre-fix > final text. */
function originalPredText(entry: GeminiEntry): string {
  return entry.text_pre_alphabet_fix ?? entry.text_pre_snap ?? entry.text;
}

/** Yield (page, resultsJsonPath) pairs from both the new flat layout
 *  (output/gemini/results_pNNN.json) and the legacy per-page-subdir layout
 *  (output/page_NNN_gemini/results.json). New layout takes precedence when
 *  both are present. */
async function* findPageResults(): AsyncGenerator<[number, string]> {
  const seen = new Set<number>();

  // New layout
  try {
    const files = await readdir(GEMINI_DIR, { withFileTypes: true });
    for (const f of files) {
      if (!f.isFile()) continue;
      const m = f.name.match(/^results_p(\d+)\.json$/);
      if (!m) continue;
      const page = parseInt(m[1], 10);
      seen.add(page);
      yield [page, join(GEMINI_DIR, f.name)];
    }
  } catch {
    // gemini/ dir missing — fine, only legacy layout present
  }

  // Legacy layout fallback
  try {
    const subs = await readdir(SCANNER_OUTPUT_DIR, { withFileTypes: true });
    for (const sub of subs) {
      if (!sub.isDirectory()) continue;
      const m = sub.name.match(/^page_(\d+)_gemini$/);
      if (!m) continue;
      const page = parseInt(m[1], 10);
      if (seen.has(page)) continue;
      yield [page, join(SCANNER_OUTPUT_DIR, sub.name, "results.json")];
    }
  } catch {
    // output/ dir missing entirely — caller will print 0 pages
  }
}

async function main() {
  console.log(`Reading Gemini output from: ${GEMINI_DIR}`);

  const pages: Array<[number, string]> = [];
  for await (const pair of findPageResults()) {
    pages.push(pair);
  }
  pages.sort((a, b) => a[0] - b[0]);

  console.log(`Found ${pages.length} page result files.\n`);

  let totalRows = 0;
  let pagesImported = 0;
  let pagesSkipped = 0;

  for (const [page, resultsPath] of pages) {
    const results = await readJsonOrNull<GeminiPageResults>(resultsPath);
    if (!results || !Array.isArray(results.entries)) {
      pagesSkipped++;
      continue;
    }

    const rows: (typeof schema.entries.$inferInsert)[] = [];
    results.entries.forEach((entry, idx) => {
      const finalText = (entry.text || "").trim();
      const finalGlossRaw = (entry.gloss || "").trim();
      if (!finalText && !finalGlossRaw) return;

      const predText = originalPredText(entry).trim();
      const snappedFrom = entry.text_pre_snap?.trim() || null;

      rows.push({
        page,
        entryIdx: idx,
        text: finalText,
        glossRaw: finalGlossRaw,
        glosses: splitGlossString(finalGlossRaw),
        state: "pending",
        edited: false,
        isMultiRegion: false,
        predTextRaw: predText || null,
        predGlossRaw: finalGlossRaw || null,
        snappedFrom,
        bboxRegions: null,
        source: "gemini",
      });
    });

    if (rows.length === 0) {
      pagesSkipped++;
      continue;
    }

    // Upsert: ON CONFLICT (page, entry_idx) DO UPDATE so re-runs are idempotent.
    // We DON'T overwrite `text` / `gloss_raw` / `state` / `edited` if a human
    // has already reviewed — but for the initial import everything is `pending`
    // so the simple "overwrite" is fine. If you re-import after corrections,
    // adjust this to skip rows where edited=true.
    await db
      .insert(schema.entries)
      .values(rows)
      .onConflictDoUpdate({
        target: [schema.entries.page, schema.entries.entryIdx],
        set: {
          text: sql`excluded.text`,
          glossRaw: sql`excluded.gloss_raw`,
          glosses: sql`excluded.glosses`,
          isMultiRegion: sql`excluded.is_multi_region`,
          predTextRaw: sql`excluded.pred_text_raw`,
          predGlossRaw: sql`excluded.pred_gloss_raw`,
          snappedFrom: sql`excluded.snapped_from`,
          bboxRegions: sql`excluded.bbox_regions`,
          source: sql`excluded.source`,
          updatedAt: new Date(),
        },
      });

    totalRows += rows.length;
    pagesImported++;
    console.log(
      `  page ${page.toString().padStart(3, "0")}: ${rows.length} entries upserted`
    );
  }

  console.log(
    `\nDone. Pages imported: ${pagesImported}, skipped: ${pagesSkipped}, total entries: ${totalRows}`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("\nImport failed:", err);
  process.exit(1);
});
