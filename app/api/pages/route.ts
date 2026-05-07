import { NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { sql } from "drizzle-orm";

// Force fresh DB read on every request — page list reflects current state
// (deletes/imports/etc.) without going through Vercel's build-time cache.
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/pages
 * Returns the distinct page numbers that have at least one entry, plus
 * per-page state counts for the sidebar dropdown.
 */
export async function GET() {
  const rows = await db
    .select({
      page: schema.entries.page,
      total: sql<number>`count(*)::int`,
      pending: sql<number>`count(*) filter (where state = 'pending')::int`,
      accepted: sql<number>`count(*) filter (where state = 'accepted')::int`,
      rejected: sql<number>`count(*) filter (where state = 'rejected')::int`,
      no_ouv: sql<number>`count(*) filter (where state = 'no_ouv')::int`,
    })
    .from(schema.entries)
    .groupBy(schema.entries.page)
    .orderBy(schema.entries.page);
  return NextResponse.json(
    { pages: rows },
    { headers: { "Cache-Control": "no-store, max-age=0, must-revalidate" } },
  );
}
