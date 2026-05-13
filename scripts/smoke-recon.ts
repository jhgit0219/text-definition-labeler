/**
 * Smoke test: pick a spreadsheet entry whose reconstruction we migrated from
 * the iter-5 SQLite cache, then exercise the same join the GET
 * /api/recon/:entry_id route does. Confirms the (text, gloss) cache key
 * lines up byte-identically across the two import paths.
 *
 * Run:
 *   npx tsx scripts/smoke-recon.ts [text]
 *   npx tsx scripts/smoke-recon.ts Babuy
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

async function main() {
  const target = process.argv[2] ?? "Babuy";
  const [entry] = await db
    .select()
    .from(schema.entries)
    .where(eq(schema.entries.text, target))
    .limit(1);
  if (!entry) {
    console.log(`No entry found with text=${JSON.stringify(target)}`);
    process.exit(1);
  }
  console.log(
    `Entry id=${entry.id} page=${entry.page} entry_idx=${entry.entryIdx} state=${entry.state} source=${entry.source}`,
  );
  console.log(`  text=${JSON.stringify(entry.text)}`);
  console.log(`  glossRaw=${JSON.stringify(entry.glossRaw)}`);
  console.log(`  spreadsheet_protos=${JSON.stringify(entry.spreadsheetProtos)}`);
  console.log(`  notes=${JSON.stringify(entry.notes)}`);

  const text = normalizeText(entry.text);
  const gloss = normalizeGloss(entry.glossRaw);
  const [recon] = await db
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

  if (!recon) {
    console.log(`\nNo reconstruction row for (text=${JSON.stringify(text)}, gloss=${JSON.stringify(gloss)}).`);
    process.exit(0);
  }

  const rankings = (recon.rankings as Array<{ rank: number; proto_form: string; pidno: number; is_match: boolean }>) ?? [];
  console.log(`\nReconstruction id=${recon.id} status=${recon.status} schema_version=${recon.schemaVersion}`);
  console.log(`  model=${recon.modelId} prompt=${recon.promptVersion}`);
  console.log(`  n_rankings=${rankings.length}`);
  for (const r of rankings.slice(0, 5)) {
    console.log(
      `    #${r.rank} pidno=${r.pidno} ${r.proto_form}${r.is_match ? " [credible]" : ""}`,
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
