import { NextRequest, NextResponse } from "next/server";
import { and, asc, count, eq, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/**
 * GET /api/acd/letter/[letter]?page=1&pageSize=50
 *
 * Letter-by-letter browse over the full ACD reconstruction corpus,
 * sorted alphabetically by form_plain. Used by the /dictionary route.
 *
 * Returns paginated reconstructions; reflexes are NOT included here to
 * keep payloads small. The dictionary UI fetches reflexes on demand via
 * GET /api/acd/reconstruction/[pidno].
 *
 * The letter param accepts a single lowercase ASCII letter (a-z); any
 * other value normalizes to `?` (the bucket used at import time for
 * entries whose form_plain has no ASCII initial).
 */

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;

function parseLetter(raw: string): string {
  const t = decodeURIComponent(raw || "").trim().toLowerCase();
  if (t.length === 1 && t >= "a" && t <= "z") return t;
  return "?";
}

function parsePositiveInt(
  raw: string | null,
  fallback: number,
  max: number,
): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export async function GET(
  req: NextRequest,
  { params }: { params: { letter: string } },
) {
  const letter = parseLetter(params.letter);
  const page = parsePositiveInt(req.nextUrl.searchParams.get("page"), 1, 10_000);
  const pageSize = parsePositiveInt(
    req.nextUrl.searchParams.get("pageSize"),
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  );

  const offset = (page - 1) * pageSize;

  const [totals] = await db
    .select({ total: count() })
    .from(schema.acdReconstructions)
    .where(eq(schema.acdReconstructions.firstLetter, letter));

  const rows = await db
    .select({
      pidno: schema.acdReconstructions.pidno,
      protoCode: schema.acdReconstructions.protoCode,
      form: schema.acdReconstructions.form,
      formPlain: schema.acdReconstructions.formPlain,
      glossText: schema.acdReconstructions.glossText,
      setNum: schema.acdReconstructions.setNum,
      reflexCount: sql<number>`(
        SELECT COUNT(*)::int FROM acd_reflexes
        WHERE acd_reflexes.pidno = ${schema.acdReconstructions.pidno}
      )`.as("reflex_count"),
    })
    .from(schema.acdReconstructions)
    .where(eq(schema.acdReconstructions.firstLetter, letter))
    .orderBy(asc(schema.acdReconstructions.formPlain), asc(schema.acdReconstructions.pidno))
    .limit(pageSize)
    .offset(offset);

  const totalRows = totals?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));

  return NextResponse.json({
    letter,
    page,
    pageSize,
    totalRows,
    totalPages,
    rows,
  });
}
