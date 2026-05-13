/**
 * Smoke test the text-only fallback: simulate what GET /api/recon/[entry_id]
 * does for entries whose strict (text, gloss) lookup misses.
 *
 * Picks one strict-hit (Apdo) and one loose-hit (Babuy) and prints the
 * cache-hit metadata each would return to the UI.
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { db, schema } from "../lib/db";
import { and, eq } from "drizzle-orm";

const CANONICAL_MODEL_ID = "claude-opus-4-7";
const CANONICAL_PROMPT_VERSION = "v2-agent";

function normalizeText(s: string | null | undefined): string {
  if (s == null) return "";
  return s.trim();
}
function normalizeGloss(s: string | null | undefined): string {
  if (s == null) return "";
  return s.trim().replace(/\s+/g, " ");
}

async function probe(textTarget: string) {
  const [entry] = await db
    .select()
    .from(schema.entries)
    .where(eq(schema.entries.text, textTarget))
    .limit(1);
  if (!entry) {
    console.log(`  ${textTarget}: entry not found`);
    return;
  }
  const text = normalizeText(entry.text);
  const gloss = normalizeGloss(entry.glossRaw);
  // Strict
  const [strict] = await db
    .select()
    .from(schema.reconstructions)
    .where(
      and(
        eq(schema.reconstructions.text, text),
        eq(schema.reconstructions.gloss, gloss),
        eq(schema.reconstructions.modelId, CANONICAL_MODEL_ID),
        eq(schema.reconstructions.promptVersion, CANONICAL_PROMPT_VERSION),
      ),
    );
  let chosen = strict;
  let loose = false;
  if (!chosen) {
    const looseRows = await db
      .select()
      .from(schema.reconstructions)
      .where(
        and(
          eq(schema.reconstructions.text, text),
          eq(schema.reconstructions.modelId, CANONICAL_MODEL_ID),
          eq(schema.reconstructions.promptVersion, CANONICAL_PROMPT_VERSION),
        ),
      )
      .limit(2);
    if (looseRows.length === 1) {
      chosen = looseRows[0];
      loose = true;
    }
  }
  const rankings = (chosen?.rankings as Array<{ proto_form: string; pidno: number; rank: number }>) ?? [];
  const top = rankings[0];
  console.log(
    `  ${textTarget}: entryGloss=${JSON.stringify(entry.glossRaw).slice(0, 50)} ` +
      (chosen
        ? `hit${loose ? " (loose)" : ""} top1=${top?.proto_form} pidno=${top?.pidno}`
        : "MISS"),
  );
}

async function main() {
  await probe("Apdo"); // expected strict hit
  await probe("Babuy"); // expected loose hit
  await probe("Bocboc"); // expected loose hit
  await probe("Bago"); // expected loose hit
  await probe("Acub"); // strict or loose?
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
