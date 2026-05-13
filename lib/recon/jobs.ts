import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

type JobRow = typeof schema.reconJobs.$inferSelect;

export interface ActiveJobDto {
  id: number;
  status: "pending" | "running" | "done" | "error";
  position: number | null;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorKind: string | null;
  errorMessage: string | null;
}

export async function loadActiveJob(entryId: number): Promise<ActiveJobDto | null> {
  const [job] = await db
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
  if (!job) return null;
  return toActiveJobDto(job, await loadJobPosition(job));
}

export async function loadJobById(jobId: number): Promise<JobRow | null> {
  const [job] = await db
    .select()
    .from(schema.reconJobs)
    .where(eq(schema.reconJobs.id, jobId));
  return job ?? null;
}

export async function loadJobPosition(job: JobRow): Promise<number | null> {
  if (job.status !== "pending") return null;
  const [{ ahead }] = await db
    .select({ ahead: sql<number>`COUNT(*)::int`.as("ahead") })
    .from(schema.reconJobs)
    .where(
      and(
        inArray(schema.reconJobs.status, ["pending", "running"]),
        sql`${schema.reconJobs.id} < ${job.id}`,
      ),
    );
  return ahead + 1;
}

export function toActiveJobDto(job: JobRow, position: number | null): ActiveJobDto {
  return {
    id: job.id,
    status: job.status as ActiveJobDto["status"],
    position,
    enqueuedAt: job.enqueuedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    errorKind: job.errorKind,
    errorMessage: job.errorMessage,
  };
}
