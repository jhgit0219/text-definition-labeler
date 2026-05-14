import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import {
  loadJobPosition,
  toActiveJobDto,
  type ActiveJobDto,
} from "@/lib/recon/jobs";

// Polled by the recon panel while a job is pending/running. Returns the
// latest active job for the entry, OR the most recent settled job
// (status=done|error) so the panel can render a terminal banner before
// switching back to the cache view on the next GET /api/recon.
//
// DELETE cancels a *pending* job for the entry. Running jobs are left
// alone — cancelling mid-claude-call would require subprocess signalling
// the worker doesn't currently support.

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

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { entry_id: string } },
) {
  const entryId = Number.parseInt(params.entry_id, 10);
  if (!Number.isFinite(entryId) || entryId <= 0) {
    return NextResponse.json({ error: "bad entry_id" }, { status: 400 });
  }

  // Only pending rows are cancellable. If a worker has already claimed
  // the job (status=running), let the agent finish — the annotator can
  // discard the result via the "clear" button on the done view.
  const deleted = await db
    .delete(schema.reconJobs)
    .where(
      and(
        eq(schema.reconJobs.entryId, entryId),
        eq(schema.reconJobs.status, "pending"),
      ),
    )
    .returning({ id: schema.reconJobs.id });

  return NextResponse.json({ cancelled: deleted.length });
}
