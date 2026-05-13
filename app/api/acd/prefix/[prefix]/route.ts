import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, inArray, like, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/**
 * GET /api/acd/prefix/[prefix]?layers=PMP,PAN&q=hemp
 *
 * Returns ALL reconstructions whose form_plain starts with the given
 * lowercase 1–2 letter prefix. The /dictionary route loads the whole
 * prefix at once and filters/searches client-side — much smoother than
 * paginating, and prefix buckets are small enough (worst case ~200
 * entries under e.g. "Ba") that the payload stays tight.
 *
 * Query params (all optional):
 *   layers   — comma-separated proto-code filter (e.g. "PMP,PAN"). When
 *              present, only rows whose proto_code is in the list are
 *              returned. Empty / missing = no filter.
 *
 * Reflex counts come from a separate GROUP BY query joined in JS — the
 * previous correlated-subquery formulation returned the table-wide
 * total instead of the per-pidno count (Drizzle did not correlate the
 * subquery against the outer row).
 */

const MAX_ROWS = 1_000; // safety cap; no real prefix is this large

function parsePrefix(raw: string): string {
  const t = decodeURIComponent(raw || "").trim().toLowerCase();
  if (t.length === 0 || t.length > 2) return "";
  for (const ch of t) {
    if (!(ch >= "a" && ch <= "z")) return "";
  }
  return t;
}

function parseLayers(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length < 32);
}

export async function GET(
  req: NextRequest,
  { params }: { params: { prefix: string } },
) {
  const prefix = parsePrefix(params.prefix);
  if (!prefix) {
    return NextResponse.json({ error: "bad prefix" }, { status: 400 });
  }
  const layers = parseLayers(req.nextUrl.searchParams.get("layers"));

  const conditions = [like(schema.acdReconstructions.formPlain, `${prefix}%`)];
  if (layers.length > 0) {
    conditions.push(inArray(schema.acdReconstructions.protoCode, layers));
  }

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
    .limit(MAX_ROWS);

  // Reflex counts — separate GROUP BY, joined in JS. The previous
  // correlated-subquery approach was returning the full table total
  // rather than per-pidno counts.
  const reflexCounts =
    rows.length === 0
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
              rows.map((r) => r.pidno),
            ),
          )
          .groupBy(schema.acdReflexes.pidno);
  const reflexCountByPidno = new Map<number, number>(
    reflexCounts.map((r) => [r.pidno, r.count]),
  );

  // Distinct proto-codes inside this prefix — used to render the layer
  // filter pills. Cheap to compute on the result set we already have.
  const protoCodesInPrefix = Array.from(
    new Set(rows.map((r) => r.protoCode)),
  ).sort();

  const enriched = rows.map((r) => ({
    ...r,
    reflexCount: reflexCountByPidno.get(r.pidno) ?? 0,
  }));

  return NextResponse.json({
    prefix,
    layers,
    totalRows: enriched.length,
    protoCodesInPrefix,
    rows: enriched,
  });
}
