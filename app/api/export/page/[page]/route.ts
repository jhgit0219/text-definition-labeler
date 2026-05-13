import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { buildXlsxBuffer, hasOUV, type EntryForExport } from "@/lib/xlsx";

/**
 * POST /api/export/page/:page
 *
 * Streams a single page's accepted entries (with attached reconstruction
 * picks) as a download. Used by the "Export THIS page" button so reviewers
 * can offload validated data incrementally.
 *
 * Query params:
 *   ?picks_only=1  — restrict to entries with at least one pick. Default
 *                    includes all accepted entries on the page.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { page: string } },
) {
  const page = Number.parseInt(params.page, 10);
  if (!Number.isFinite(page)) {
    return NextResponse.json({ error: "bad page" }, { status: 400 });
  }
  const accepted = await db
    .select()
    .from(schema.entries)
    .where(and(eq(schema.entries.page, page), eq(schema.entries.state, "accepted")))
    .orderBy(schema.entries.entryIdx);

  const enriched = await enrichWithPicks(accepted);
  const filtered = enriched.filter((r) => hasOUV(r.text));
  const picksOnly = req.nextUrl.searchParams.get("picks_only");
  const final =
    picksOnly === "1" || picksOnly === "true"
      ? filtered.filter((r) => r.picks.length > 0)
      : filtered;

  const buf = await buildXlsxBuffer(final, `page_${page}`);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="page_${page
        .toString()
        .padStart(3, "0")}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}

async function enrichWithPicks(
  entries: (typeof schema.entries.$inferSelect)[],
): Promise<EntryForExport[]> {
  if (entries.length === 0) return [];
  const ids = entries.map((e) => e.id);
  const picks = await db
    .select({
      entryId: schema.entryReconstructionPicks.entryId,
      pidno: schema.entryReconstructionPicks.pidno,
      protoForm: schema.entryReconstructionPicks.protoForm,
      isPrimary: schema.entryReconstructionPicks.isPrimary,
    })
    .from(schema.entryReconstructionPicks)
    .where(inArray(schema.entryReconstructionPicks.entryId, ids));
  const byEntry = new Map<number, EntryForExport["picks"]>();
  for (const p of picks) {
    if (!byEntry.has(p.entryId)) byEntry.set(p.entryId, []);
    byEntry.get(p.entryId)!.push({
      pidno: p.pidno,
      protoForm: p.protoForm,
      isPrimary: p.isPrimary,
    });
  }
  return entries.map((e) => ({ ...e, picks: byEntry.get(e.id) ?? [] }));
}
