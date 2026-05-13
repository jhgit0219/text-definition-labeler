import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/lib/db";

/**
 * POST /api/recon/[entry_id]/picks/append
 *
 * Append a single manual pick from the /dictionary browse view without
 * disturbing the entry's existing picks. The pick references a row in
 * `acd_reconstructions`, NOT in `reconstructions` (the AI rankings
 * cache), so `reconstruction_id` is set to NULL and `source` to "manual"
 * — the iter-2 schema change made that legal.
 *
 * Body shape: { pidno: number, isPrimary?: boolean }.
 *
 * If a pick with the same (entry_id, pidno) already exists, this is a
 * no-op (returns 200 with the existing row). The unique constraint on
 * (entry_id, pidno) prevents duplicates and races.
 */

const bodySchema = z.object({
  pidno: z.number().int().positive(),
  isPrimary: z.boolean().optional().default(false),
});

function parseEntryId(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { entry_id: string } },
) {
  const entryId = parseEntryId(params.entry_id);
  if (entryId === null) {
    return NextResponse.json({ error: "bad entry_id" }, { status: 400 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "invalid body", detail: err instanceof Error ? err.message : "" },
      { status: 400 },
    );
  }

  const [entry] = await db
    .select({ id: schema.entries.id })
    .from(schema.entries)
    .where(eq(schema.entries.id, entryId));
  if (!entry) {
    return NextResponse.json({ error: "entry not found" }, { status: 404 });
  }

  const [acd] = await db
    .select({
      pidno: schema.acdReconstructions.pidno,
      protoForm: schema.acdReconstructions.form,
    })
    .from(schema.acdReconstructions)
    .where(eq(schema.acdReconstructions.pidno, body.pidno));
  if (!acd) {
    return NextResponse.json(
      { error: `pidno ${body.pidno} not in ACD corpus` },
      { status: 400 },
    );
  }

  // If isPrimary=true, clear any existing primary so the "exactly one
  // primary" invariant holds. Otherwise, leave existing primaries alone.
  // Wrap in a transaction so the clear + insert are atomic.
  const result = await db.transaction(async (tx) => {
    if (body.isPrimary) {
      await tx
        .update(schema.entryReconstructionPicks)
        .set({ isPrimary: false })
        .where(eq(schema.entryReconstructionPicks.entryId, entryId));
    }
    const [inserted] = await tx
      .insert(schema.entryReconstructionPicks)
      .values({
        entryId,
        reconstructionId: null,
        pidno: acd.pidno,
        protoForm: acd.protoForm,
        isPrimary: body.isPrimary,
        source: "manual",
      })
      .onConflictDoNothing({
        target: [
          schema.entryReconstructionPicks.entryId,
          schema.entryReconstructionPicks.pidno,
        ],
      })
      .returning();
    if (inserted) return inserted;
    // Already existed — return the existing row.
    const [existing] = await tx
      .select()
      .from(schema.entryReconstructionPicks)
      .where(
        and(
          eq(schema.entryReconstructionPicks.entryId, entryId),
          eq(schema.entryReconstructionPicks.pidno, body.pidno),
        ),
      );
    return existing;
  });

  return NextResponse.json({
    pick: {
      id: result.id,
      pidno: result.pidno,
      protoForm: result.protoForm,
      isPrimary: result.isPrimary,
      source: result.source,
    },
  });
}
