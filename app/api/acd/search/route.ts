import { NextRequest, NextResponse } from "next/server";
import { and, asc, ilike, inArray, or, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/**
 * GET /api/acd/search?q=ashes&layers=PMP,PAN&limit=200
 *
 * Cross-corpus search across the full 12K-row ACD reconstruction set.
 * Used by the /dictionary route when the annotator flips the search
 * scope toggle from "this prefix only" to "all prefixes". Matches are
 * case-insensitive substring searches against four fields combined
 * with OR:
 *   - form_plain    (the de-asterisked stem, e.g. "qabu")
 *   - form          (with all the ACD orthographic decoration)
 *   - gloss_text    (Engish gloss as recorded in ACD)
 *   - proto_code    (PAN, PMP, PWMP, etc.)
 *
 * Optional `layers` query param filters to specific proto-codes the
 * way the prefix endpoint does. Default cap of 200 results keeps the
 * payload bounded for very common terms.
 */

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

function parseLayers(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length < 32);
}

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  if (q.length < 2) {
    return NextResponse.json({
      query: q,
      totalRows: 0,
      truncated: false,
      protoCodesInResults: [],
      rows: [],
    });
  }
  const layers = parseLayers(req.nextUrl.searchParams.get("layers"));
  const limit = parseLimit(req.nextUrl.searchParams.get("limit"));

  const pattern = `%${q}%`;
  const conditions = [
    or(
      ilike(schema.acdReconstructions.formPlain, pattern),
      ilike(schema.acdReconstructions.form, pattern),
      ilike(schema.acdReconstructions.glossText, pattern),
      ilike(schema.acdReconstructions.protoCode, pattern),
    )!,
  ];
  if (layers.length > 0) {
    conditions.push(inArray(schema.acdReconstructions.protoCode, layers));
  }

  // Fetch one extra row so we can flag truncation accurately.
  const rows = await db
    .select({
      pidno: schema.acdReconstructions.pidno,
      protoCode: schema.acdReconstructions.protoCode,
      form: schema.acdReconstructions.form,
      formPlain: schema.acdReconstructions.formPlain,
      glossText: schema.acdReconstructions.glossText,
      setNum: schema.acdReconstructions.setNum,
    })
    .from(schema.acdReconstructions)
    .where(and(...conditions))
    .orderBy(asc(schema.acdReconstructions.formPlain), asc(schema.acdReconstructions.pidno))
    .limit(limit + 1);

  const truncated = rows.length > limit;
  const trimmed = truncated ? rows.slice(0, limit) : rows;

  const reflexCounts =
    trimmed.length === 0
      ? []
      : await db
          .select({
            pidno: schema.acdReflexes.pidno,
            count: sql<number>`COUNT(*)::int`.as("count"),
          })
          .from(schema.acdReflexes)
          .where(
            inArray(
              schema.acdReflexes.pidno,
              trimmed.map((r) => r.pidno),
            ),
          )
          .groupBy(schema.acdReflexes.pidno);
  const reflexCountByPidno = new Map<number, number>(
    reflexCounts.map((r) => [r.pidno, r.count]),
  );

  const enriched = trimmed.map((r) => ({
    ...r,
    reflexCount: reflexCountByPidno.get(r.pidno) ?? 0,
  }));

  const protoCodesInResults = Array.from(
    new Set(enriched.map((r) => r.protoCode)),
  ).sort();

  return NextResponse.json({
    query: q,
    totalRows: enriched.length,
    truncated,
    protoCodesInResults,
    rows: enriched,
  });
}
