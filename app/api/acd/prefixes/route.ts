import { NextResponse } from "next/server";
import { asc, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

// The histogram depends on whatever's currently in acd_reconstructions,
// so don't let Next.js prerender (and freeze) the response at build time.
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/acd/prefixes
 *
 * Returns the histogram of 2-letter prefixes present in the ACD corpus,
 * sorted alphabetically. The /dictionary route uses it to render its
 * nav: one row per letter, each row showing only the 2-letter sub-
 * prefixes that actually contain entries (e.g. under "A" you might see
 * Aa, Ab, Ad, Ag, …  but not Aq or Ax because the corpus has nothing
 * there).
 *
 * The full prefix list fits in well under 1 KB so it's cheap to fetch
 * once on mount.
 */
export async function GET() {
  const rows = await db
    .select({
      prefix: sql<string>`LOWER(SUBSTRING(${schema.acdReconstructions.formPlain}, 1, 2))`.as("prefix"),
      count: sql<number>`COUNT(*)::int`.as("count"),
    })
    .from(schema.acdReconstructions)
    .groupBy(sql`LOWER(SUBSTRING(${schema.acdReconstructions.formPlain}, 1, 2))`)
    .orderBy(asc(sql`LOWER(SUBSTRING(${schema.acdReconstructions.formPlain}, 1, 2))`));
  return NextResponse.json({ prefixes: rows });
}
