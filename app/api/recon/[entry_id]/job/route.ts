import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import {
  loadJobPosition,
  toActiveJobDto,
  type ActiveJobDto,
} from "../route";

// Polled by the recon panel while a job is pending/running. Returns the
// latest active job for the entry, OR the most recent settled job
// (status=done|error) so the panel can render a terminal banner before
// switching back to the cache view on the next GET /api/recon.

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { entry_id: string } },
) {
  const entryId = Number.parseInt(params.entry_id, 10);
  if (!Number.isFinite(entryId) || entryId <= 0) {
    return NextResponse.json({ error: "bad entry_id" }, { status: 400 });
  }

  const [active] = await db
    .select()
    .from(schema.reconJobs)
    .where(
      and(
        eq(schema.reconJobs.entryId, entryId),
        inArray(schema.reconJobs.status, ["pending", "running"]),
      ),
    )
    .orderBy(desc(schema.reconJobs.id))
    .limit(1);

  let job: ActiveJobDto | null = null;
  if (active) {
    job = toActiveJobDto(active, await loadJobPosition(active));
  } else {
    const [latest] = await db
      .select()
      .from(schema.reconJobs)
      .where(eq(schema.reconJobs.entryId, entryId))
      .orderBy(desc(schema.reconJobs.id))
      .limit(1);
    if (latest) job = toActiveJobDto(latest, null);
  }

  return NextResponse.json({ job });
}
