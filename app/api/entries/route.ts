import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { eq, asc } from "drizzle-orm";

// Force fresh DB read on every request — entry edits/state changes/imports
// must show up immediately, not be cached by Vercel's build-time render.
export const dynamic = "force-dynamic";
export const revalidate = 0;

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
  return NextResponse.json(
    { entries: rows },
    { headers: { "Cache-Control": "no-store, max-age=0, must-revalidate" } },
  );
}
