/**
 * Audit the (text, gloss) match rate between the 44 migrated reconstruction
 * rows and the spreadsheet's accepted entries. Identifies the words where
 * the bench-time gloss diverged from the spreadsheet gloss so we can decide
 * whether to (a) accept the cache miss, (b) duplicate the row under the
 * new gloss, or (c) loosen the lookup to text-only when a single row exists.
 *
 * Read-only. Run:
 *   npx tsx scripts/audit-recon-joins.ts
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { db, schema } from "../lib/db";
import { and, eq, sql } from "drizzle-orm";

function normalizeText(s: string | null | undefined): string {
  if (s == null) return "";
  return s.trim();
}
function normalizeGloss(s: string | null | undefined): string {
  if (s == null) return "";
  return s.trim().replace(/\s+/g, " ");
}

async function main() {
  const recons = await db
    .select()
    .from(schema.reconstructions)
    .where(
      and(
        eq(schema.reconstructions.modelId, "claude-opus-4-7"),
        eq(schema.reconstructions.promptVersion, "v2-agent"),
      ),
    );
  console.log(`Reconstructions in DB: ${recons.length}`);

  let exactHits = 0;
  let textOnlyHits = 0;
  let misses = 0;
  const mismatches: Array<{ text: string; reconGloss: string; entryGloss: string }> = [];
  const orphanRecons: Array<{ text: string; gloss: string }> = [];

  for (const r of recons) {
    const [exact] = await db
      .select({ id: schema.entries.id, glossRaw: schema.entries.glossRaw })
      .from(schema.entries)
      .where(
        and(
          eq(schema.entries.text, r.text),
          // Normalize-match by comparing the trimmed/whitespace-collapsed forms
          // in SQL — postgres has trim() built-in, and regexp_replace can
          // collapse internal whitespace.
          sql`regexp_replace(trim(${schema.entries.glossRaw}), '\\s+', ' ', 'g') = ${r.gloss}`,
        ),
      )
      .limit(1);
    if (exact) {
      exactHits++;
      continue;
    }
    const textMatches = await db
      .select({ id: schema.entries.id, glossRaw: schema.entries.glossRaw })
      .from(schema.entries)
      .where(eq(schema.entries.text, r.text))
      .limit(5);
    if (textMatches.length === 0) {
      orphanRecons.push({ text: r.text, gloss: r.gloss });
      misses++;
      continue;
    }
    textOnlyHits++;
    mismatches.push({
      text: r.text,
      reconGloss: r.gloss,
      entryGloss: textMatches.map((m) => m.glossRaw).join(" || "),
    });
  }

  console.log(`\nExact (text+gloss) hits: ${exactHits}/${recons.length}`);
  console.log(`Text-only hits (gloss differs): ${textOnlyHits}`);
  console.log(`Orphan reconstructions (text not in entries): ${misses}`);

  if (mismatches.length > 0) {
    console.log("\nText-only hits with gloss divergence:");
    for (const m of mismatches.slice(0, 50)) {
      console.log(`  ${m.text}`);
      console.log(`    recon: ${JSON.stringify(m.reconGloss)}`);
      console.log(`    entry: ${JSON.stringify(m.entryGloss)}`);
    }
  }
  if (orphanRecons.length > 0) {
    console.log("\nReconstructions with no matching entry:");
    for (const o of orphanRecons.slice(0, 20)) {
      console.log(`  ${o.text} / ${JSON.stringify(o.gloss).slice(0, 60)}`);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
