/**
 * Dev-only seed: populate the entries table with a small sample so the review
 * UI is viewable before the real bulk Gemini run finishes.
 *
 * Sample covers 3 pages (1, 23, 47) with ~10 entries each so page navigation
 * is exercised. Real text-gloss pairs from Sheet2 / Gemini results, so the
 * UI feels representative.
 *
 * Idempotent: ON CONFLICT (page, entry_idx) DO UPDATE — re-run any time.
 *
 * Run:
 *   npm run seed:dev
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { db, schema } from "../lib/db";
import { sql } from "drizzle-orm";

type Sample = { text: string; gloss: string };

// Page 1 — first 12 entries from Sheet2 (verified ground truth).
const PAGE_1: Sample[] = [
  { text: "Aasa", gloss: "De donde." },
  { text: "Abá", gloss: "Admiraciones." },
  { text: "Aba", gloss: "Pechuga." },
  { text: "Abacá", gloss: "Plantanos." },
  { text: "Abága", gloss: "Ombo. Ombrudo." },
  { text: "Abay", gloss: "Andar." },
  { text: "Abang", gloss: "Alquilar. Alquiler. Censo. Flete. Fletar. Pagar." },
  { text: "Abi", gloss: "Pense. Tener." },
  { text: "Abian", gloss: "Amigo. Amigarse. Amigar. Amistad. Camarada." },
  { text: "Abin", gloss: "Capado." },
  { text: "Abis", gloss: "Cortar." },
  { text: "Ablit", gloss: "Pasar. V. Cablit." },
];

// Page 23 — first 12 entries from the Gemini run we just verified.
const PAGE_23: Sample[] = [
  { text: "Coripar", gloss: "Echar." },
  { text: "Cosmor", gloss: "Ceño. Encapotarse. Fruncir. Malquerer. Odio. Rostrituerto. Torer." },
  { text: "Coso", gloss: "Despegar. Entregar. Entregarse. Poner." },
  { text: "Cota", gloss: "Cerca. Fortaleza. Fuerte. Castillo. Muro." },
  { text: "Cota", gloss: "Hablar. Tartamudo." },
  { text: "Cotcot", gloss: "Ahoyar. Comer. Zanja. Hoyo. Sepultura." },
  { text: "Cotcot", gloss: "Comer. Roer." },
  { text: "Coticoti", gloss: "Repetir." },
  { text: "Cotlo", gloss: "Cortar." },
  { text: "Coto", gloss: "Arrozes." },
  { text: "Coto", gloss: "Criar. Espulgar. Piojo. Pulga. Piojoso." },
  { text: "Cotocoto", gloss: "Paletilla." },
];

// Page 47 — fabricated placeholder so UI shows ≥3 pages in the navigator.
const PAGE_47: Sample[] = [
  { text: "Hauk", gloss: "Acometer. Atacar." },
  { text: "Hayag", gloss: "Claro. Luz. Manifiesto." },
  { text: "Hibog", gloss: "Espesura." },
  { text: "Hibo", gloss: "Mecer. Cuna." },
  { text: "Higala", gloss: "Amigo. Compañero." },
  { text: "Hilig", gloss: "Inclinarse. Recostar." },
  { text: "Hilom", gloss: "Silencio. Callar." },
];

function splitGlossString(s: string): string[] {
  if (!s) return [];
  return s
    .split(/\.\s+|\s*\.\s*$/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function samplesToRows(page: number, samples: Sample[]): (typeof schema.entries.$inferInsert)[] {
  return samples.map((s, idx) => ({
    page,
    entryIdx: idx,
    text: s.text,
    glossRaw: s.gloss,
    glosses: splitGlossString(s.gloss),
    state: "pending",
    edited: false,
    isMultiRegion: false,
    predTextRaw: s.text,
    predGlossRaw: s.gloss,
    snappedFrom: null,
    bboxRegions: null,
    source: "seed_dev",
  }));
}

async function main() {
  const sets: Array<[number, Sample[]]> = [
    [1, PAGE_1],
    [23, PAGE_23],
    [47, PAGE_47],
  ];

  let total = 0;
  for (const [page, samples] of sets) {
    const rows = samplesToRows(page, samples);
    await db
      .insert(schema.entries)
      .values(rows)
      .onConflictDoUpdate({
        target: [schema.entries.page, schema.entries.entryIdx],
        set: {
          text: sql`excluded.text`,
          glossRaw: sql`excluded.gloss_raw`,
          glosses: sql`excluded.glosses`,
          predTextRaw: sql`excluded.pred_text_raw`,
          predGlossRaw: sql`excluded.pred_gloss_raw`,
          source: sql`excluded.source`,
          updatedAt: new Date(),
        },
      });
    console.log(`  page ${page}: ${rows.length} entries seeded`);
    total += rows.length;
  }
  console.log(`\nDone. Total entries seeded: ${total}.`);
  console.log(`Open http://localhost:3000 (after \`npm run dev\`) to view.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\nSeed failed:", err);
  process.exit(1);
});
