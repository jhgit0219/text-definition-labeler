import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { buildXlsxBuffer, hasOUV } from "@/lib/xlsx";

/**
 * POST /api/export/page/:page
 *
 * Streams a single page's accepted entries as a download — used by the
 * "Export THIS page" button so reviewers can offload validated data
 * incrementally for analysis.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: { page: string } }
) {
  const page = Number.parseInt(params.page, 10);
  if (!Number.isFinite(page)) {
    return NextResponse.json({ error: "bad page" }, { status: 400 });
  }
  const rows = await db
    .select()
    .from(schema.entries)
    .where(and(eq(schema.entries.page, page), eq(schema.entries.state, "accepted")))
    .orderBy(schema.entries.entryIdx);

  const filtered = rows.filter((r) => hasOUV(r.text));
  const buf = await buildXlsxBuffer(filtered, `page_${page}`);
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
