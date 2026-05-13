/**
 * One-off fix for the iter-1 reconstruction migration: the initial Drizzle
 * `0000_reconstruction.sql` was generated against an empty migration
 * history, so the new columns on the existing `entries` table arrived
 * only as part of CREATE TABLE IF NOT EXISTS — which silently no-ops when
 * the table already exists. This script ALTERs the table to add the two
 * missing columns idempotently.
 *
 * Safe to re-run. Run:
 *   npx tsx scripts/fix-entries-columns.ts
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import postgres from "postgres";

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }
  const sql = postgres(process.env.DATABASE_URL, { prepare: false });

  const before = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'entries' AND column_name IN ('notes', 'spreadsheet_protos')
  `;
  console.log(
    "Before: entries has",
    before.map((r) => r.column_name).join(", ") || "(neither column)",
  );

  await sql`ALTER TABLE "entries" ADD COLUMN IF NOT EXISTS "notes" text`;
  await sql`ALTER TABLE "entries" ADD COLUMN IF NOT EXISTS "spreadsheet_protos" jsonb`;

  const after = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'entries' AND column_name IN ('notes', 'spreadsheet_protos')
  `;
  console.log(
    "After:  entries has",
    after.map((r) => r.column_name).join(", "),
  );

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
