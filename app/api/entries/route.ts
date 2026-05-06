import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { eq, asc } from "drizzle-orm";

/**
 * GET /api/entries?page=23
 * Returns all entries on a page in entry-index order.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const pageRaw = url.searchParams.get("page");
  const page = pageRaw ? Number.parseInt(pageRaw, 10) : NaN;
  if (!Number.isFinite(page)) {
    return NextResponse.json({ error: "page query param required" }, { status: 400 });
  }
  const rows = await db
    .select()
    .from(schema.entries)
    .where(eq(schema.entries.page, page))
    .orderBy(asc(schema.entries.entryIdx));
  return NextResponse.json({ entries: rows });
}
