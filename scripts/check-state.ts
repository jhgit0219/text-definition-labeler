/**
 * Read-only DB state report. Run before the spreadsheet import so we know
 * what's already in the entries table on pages 1–26 (the range the schwa
 * spreadsheet covers) and can choose an appropriate conflict policy.
 *
 * Outputs: total entries, counts by state and source, per-page state
 * breakdown for pages 1–26, and a few sample text/gloss pairs per state.
 *
 * No mutations. Safe to run any time.
 *
 * Run:
 *   npm run db:check-state
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { db, schema } from "../lib/db";
import { sql, eq, and, lte, gte } from "drizzle-orm";

const { entries } = schema;

async function main() {
  const total = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(entries);
  console.log(`Total entries: ${total[0]?.count ?? 0}`);
  console.log("");

  const byState = await db
    .select({
      state: entries.state,
      count: sql<number>`count(*)::int`,
    })
    .from(entries)
    .groupBy(entries.state)
    .orderBy(entries.state);
  console.log("Counts by state:");
  for (const row of byState) {
    console.log(`  ${row.state.padEnd(10)} ${row.count}`);
  }
  console.log("");

  const bySource = await db
    .select({
      source: entries.source,
      count: sql<number>`count(*)::int`,
    })
    .from(entries)
    .groupBy(entries.source)
    .orderBy(entries.source);
  console.log("Counts by source:");
  for (const row of bySource) {
    console.log(`  ${row.source.padEnd(20)} ${row.count}`);
  }
  console.log("");

  console.log("Pages 1–26 — state breakdown (page, state, count):");
  const perPage = await db
    .select({
      page: entries.page,
      state: entries.state,
      count: sql<number>`count(*)::int`,
    })
    .from(entries)
    .where(and(gte(entries.page, 1), lte(entries.page, 26)))
    .groupBy(entries.page, entries.state)
    .orderBy(entries.page, entries.state);
  if (perPage.length === 0) {
    console.log("  (no entries on pages 1–26)");
  } else {
    let currentPage = -1;
    for (const row of perPage) {
      if (row.page !== currentPage) {
        if (currentPage !== -1) console.log("");
        currentPage = row.page;
        console.log(`  page ${String(row.page).padStart(3)}`);
      }
      console.log(`    ${row.state.padEnd(10)} ${row.count}`);
    }
  }
  console.log("");

  console.log("Sample entries per state (up to 3 each):");
  const states = byState.map((r) => r.state);
  for (const state of states) {
    const samples = await db
      .select({
        id: entries.id,
        page: entries.page,
        entryIdx: entries.entryIdx,
        text: entries.text,
        glossRaw: entries.glossRaw,
      })
      .from(entries)
      .where(eq(entries.state, state))
      .limit(3);
    console.log(`  [${state}]`);
    for (const s of samples) {
      const gloss =
        s.glossRaw.length > 60 ? s.glossRaw.slice(0, 57) + "..." : s.glossRaw;
      console.log(
        `    p${String(s.page).padStart(3)}/${String(s.entryIdx).padStart(2)} ${s.text.padEnd(16)} ${gloss}`,
      );
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
