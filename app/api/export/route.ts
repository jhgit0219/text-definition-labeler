import { NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { buildXlsxBuffer, hasOUV } from "@/lib/xlsx";

/**
 * POST /api/export
 *
 * Streams an xlsx of every accepted entry across all pages back as a
 * download. Excludes entries whose text doesn't pass the OUV filter
 * (defense-in-depth — out of scope for the deliverable).
 */
export async function POST() {
  const rows = await db
    .select()
    .from(schema.entries)
    .where(eq(schema.entries.state, "accepted"))
    .orderBy(schema.entries.page, schema.entries.entryIdx);

  const filtered = rows.filter((r) => hasOUV(r.text));
  const buf = await buildXlsxBuffer(filtered, "Predictions");
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="validated_predictions.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
