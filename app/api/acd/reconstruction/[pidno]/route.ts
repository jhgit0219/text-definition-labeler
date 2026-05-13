import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/**
 * GET /api/acd/reconstruction/[pidno]
 *
 * Returns one ACD reconstruction plus all its daughter-language
 * reflexes. The /dictionary route calls this lazily when the annotator
 * expands a row — keeps the letter-page payload small (no embedded
 * reflexes) while making the per-row drill-down a single round trip.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { pidno: string } },
) {
  const pidno = Number.parseInt(params.pidno, 10);
  if (!Number.isFinite(pidno) || pidno <= 0) {
    return NextResponse.json({ error: "bad pidno" }, { status: 400 });
  }
  const [recon] = await db
    .select()
    .from(schema.acdReconstructions)
    .where(eq(schema.acdReconstructions.pidno, pidno));
  if (!recon) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const reflexes = await db
    .select({
      id: schema.acdReflexes.id,
      subgroupCode: schema.acdReflexes.subgroupCode,
      languageName: schema.acdReflexes.languageName,
      form: schema.acdReflexes.form,
      formPlain: schema.acdReflexes.formPlain,
      glossText: schema.acdReflexes.glossText,
      position: schema.acdReflexes.position,
    })
    .from(schema.acdReflexes)
    .where(eq(schema.acdReflexes.pidno, pidno))
    .orderBy(asc(schema.acdReflexes.position), asc(schema.acdReflexes.id));
  return NextResponse.json({ reconstruction: recon, reflexes });
}
