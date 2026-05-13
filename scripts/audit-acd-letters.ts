/**
 * Audit every distinct first-character of `acd_reconstructions.form_plain`.
 * Reports each char with its Unicode codepoint and row count, sorted by
 * count desc. Highlights non-ASCII letters that would currently be
 * filtered out of the dictionary prefix nav (or bucketed under '?'
 * because the import-time `_first_letter` helper only recognises a-z).
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { db, schema } from "../lib/db";
import { sql } from "drizzle-orm";

async function main() {
  const rows = await db
    .select({
      ch: sql<string>`LOWER(SUBSTRING(${schema.acdReconstructions.formPlain}, 1, 1))`.as("ch"),
      n: sql<number>`COUNT(*)::int`.as("n"),
    })
    .from(schema.acdReconstructions)
    .groupBy(sql`LOWER(SUBSTRING(${schema.acdReconstructions.formPlain}, 1, 1))`)
    .orderBy(sql`COUNT(*) DESC`);

  console.log("First-char distribution in acd_reconstructions.form_plain:");
  console.log();
  console.log(
    "char  codept  ascii?  n     example".padEnd(60),
  );
  console.log("-".repeat(60));
  for (const r of rows) {
    const cp = r.ch.codePointAt(0) ?? 0;
    const isAscii = cp >= 0x61 && cp <= 0x7a;
    const tag = isAscii ? "  yes " : "  NO  ";
    const sample = await db
      .select({ form: schema.acdReconstructions.form })
      .from(schema.acdReconstructions)
      .where(
        sql`LOWER(SUBSTRING(${schema.acdReconstructions.formPlain}, 1, 1)) = ${r.ch}`,
      )
      .limit(1);
    const example = sample[0]?.form ?? "";
    console.log(
      `${JSON.stringify(r.ch).padEnd(6)} U+${cp.toString(16).toUpperCase().padStart(4, "0")}  ${tag} ${String(r.n).padEnd(5)} ${example}`,
    );
  }
  process.exit(0);
}
main();
