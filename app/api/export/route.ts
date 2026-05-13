import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { eq, inArray } from "drizzle-orm";
import { buildXlsxBuffer, hasOUV, type EntryForExport } from "@/lib/xlsx";

/**
 * POST /api/export
 *
 * Streams an xlsx of every accepted entry across all pages back as a
 * download. Excludes entries whose text doesn't pass the OUV filter
 * (defense-in-depth — out of scope for the deliverable).
 *
 * Query params:
 *   ?picks_only=1  — restrict to entries that have at least one
 *                    reconstruction pick. Default: include all accepted
 *                    entries; rows without picks export with blank
 *                    reconstruction cells so the file doubles as a
 *                    progress snapshot.
 */
export async function POST(req: NextRequest) {
  const picksOnly = req.nextUrl.searchParams.get("picks_only");
  const accepted = await db
    .select()
    .from(schema.entries)
    .where(eq(schema.entries.state, "accepted"))
    .orderBy(schema.entries.page, schema.entries.entryIdx);

  const enriched = await enrichWithPicks(accepted);
  const filtered = enriched.filter((r) => hasOUV(r.text));
  const final =
    picksOnly === "1" || picksOnly === "true"
      ? filtered.filter((r) => r.picks.length > 0)
      : filtered;

  const buf = await buildXlsxBuffer(final, "Predictions");
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="validated_predictions.xlsx"`,
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
