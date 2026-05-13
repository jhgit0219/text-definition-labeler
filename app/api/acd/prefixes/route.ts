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
 * restricted to clean lowercase ASCII letter pairs (a-z a-z). The
 * /dictionary nav uses this to render one row per letter listing only
 * the 2-letter sub-prefixes that actually contain entries.
 *
 * Prefixes built from proto-form notation cruft — leading parens,
 * angle brackets, asterisks, hyphens, schwa glyphs, etc. — are filtered
 * out here so the nav stays scannable. The few entries those represent
 * (e.g. *-an, *(b)ari, *<um>kail) remain visible inside whatever real
 * a-z bucket they ALSO fall under via the form's other characters; if
 * a researcher really needs them, the search bar still finds them.
 *
 * The full prefix list fits in well under 1 KB so it's cheap to fetch
 * once on mount.
 */
export async function GET() {
  // Take the first two characters of the lowercased form_plain. The
  // ascii(...) check below is explicit ASCII-byte filtering instead of
  // `~ '^[a-z][a-z]$'` — POSIX character classes in PostgreSQL's
  // default UTF-8 collation are locale-aware, so `[a-z]` happily
  // matches `ŋ`, `ə`, `ñ`, and other Latin-extended letters used in
  // proto-form transcription. We only want a..z, byte values 97-122.
  const formPlain = schema.acdReconstructions.formPlain;
  const prefixExpr = sql<string>`LOWER(SUBSTRING(${formPlain}, 1, 2))`;
  const rows = await db
    .select({
      prefix: prefixExpr.as("prefix"),
      count: sql<number>`COUNT(*)::int`.as("count"),
    })
    .from(schema.acdReconstructions)
    .where(
      sql`
        LENGTH(${formPlain}) >= 2
        AND ASCII(LOWER(SUBSTRING(${formPlain}, 1, 1))) BETWEEN 97 AND 122
        AND ASCII(LOWER(SUBSTRING(${formPlain}, 2, 1))) BETWEEN 97 AND 122
      `,
    )
    .groupBy(prefixExpr)
    .orderBy(asc(prefixExpr));
  return NextResponse.json({ prefixes: rows });
}
