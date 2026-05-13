import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/lib/db";
import { normalizeText, normalizeGloss } from "@/lib/recon/normalize";
import type { Ranking } from "@/lib/recon/rankings-schema";

/**
 * PUT /api/recon/:entry_id/picks
 *
 * Replace the pick set for an entry transactionally, plus update the entry's
 * freeform notes. Body shape:
 *
 *   { picks: [{ pidno: number, isPrimary: boolean }], notes: string | null }
 *
 * Rules enforced in-handler (not just DB):
 *   - At most ONE pick has isPrimary=true. If zero, the picks array can be
 *     empty (= the annotator unmarked everything).
 *   - Every pidno must exist in the linked reconstruction's rankings JSONB.
 *   - The entry must have a reconstruction row already (cannot pick before
 *     the AI has produced candidates).
 */

const CANONICAL_MODEL_ID = "claude-opus-4-7";
const CANONICAL_PROMPT_VERSION = "v2-agent";

const pickInputSchema = z.object({
  pidno: z.number().int(),
  isPrimary: z.boolean(),
});

const bodySchema = z.object({
  picks: z.array(pickInputSchema),
  notes: z.string().nullable(),
});

type PickRow = typeof schema.entryReconstructionPicks.$inferSelect;
type ReconstructionRow = typeof schema.reconstructions.$inferSelect;

interface PickDto {
  id: number;
  pidno: number;
  protoForm: string;
  isPrimary: boolean;
}

interface ReconResponseDto {
  reconstruction: {
    id: number;
    text: string;
    gloss: string;
    modelId: string;
    promptVersion: string;
    schemaVersion: number;
    rankings: Ranking[];
    status: string;
    errorMsg: string | null;
    computedAt: string;
  } | null;
  picks: PickDto[];
  entryNotes: string | null;
}

function parseEntryId(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toReconDto(
  row: ReconstructionRow,
  picks: PickRow[],
  entryNotes: string | null,
): ReconResponseDto {
  return {
    reconstruction: {
      id: row.id,
      text: row.text,
      gloss: row.gloss,
      modelId: row.modelId,
      promptVersion: row.promptVersion,
      schemaVersion: row.schemaVersion,
      rankings: row.rankings as Ranking[],
      status: row.status,
      errorMsg: row.errorMsg,
      computedAt: row.computedAt.toISOString(),
    },
    picks: picks.map((p) => ({
      id: p.id,
      pidno: p.pidno,
      protoForm: p.protoForm,
      isPrimary: p.isPrimary,
    })),
    entryNotes,
  };
}

export async function PUT(
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

  const primaryCount = body.picks.filter((p) => p.isPrimary).length;
  if (primaryCount > 1) {
    return NextResponse.json(
      { error: "at most one pick may have isPrimary=true" },
      { status: 400 },
    );
  }

  // Find the entry, then its reconstruction row.
  const [entry] = await db
    .select({
      id: schema.entries.id,
      text: schema.entries.text,
      glossRaw: schema.entries.glossRaw,
    })
    .from(schema.entries)
    .where(eq(schema.entries.id, entryId));
  if (!entry) {
    return NextResponse.json({ error: "entry not found" }, { status: 404 });
  }

  const text = normalizeText(entry.text);
  const gloss = normalizeGloss(entry.glossRaw);

  // Strict lookup first; if no exact (text, gloss) row exists, fall back to
  // a text-only lookup under the canonical model+prompt. Same logic as the
  // GET path — annotators must be able to save picks against rows that
  // were originally computed with a slightly different gloss spelling.
  let [recon] = await db
    .select()
    .from(schema.reconstructions)
    .where(
      and(
        eq(schema.reconstructions.text, text),
        eq(schema.reconstructions.gloss, gloss),
        eq(schema.reconstructions.modelId, CANONICAL_MODEL_ID),
        eq(schema.reconstructions.promptVersion, CANONICAL_PROMPT_VERSION),
      ),
    );
  if (!recon) {
    const loose = await db
      .select()
      .from(schema.reconstructions)
      .where(
        and(
          eq(schema.reconstructions.text, text),
          eq(schema.reconstructions.modelId, CANONICAL_MODEL_ID),
          eq(schema.reconstructions.promptVersion, CANONICAL_PROMPT_VERSION),
        ),
      )
      .limit(2);
    if (loose.length === 1) {
      recon = loose[0];
    }
  }
  if (!recon) {
    return NextResponse.json(
      {
        error:
          "no reconstruction exists for this entry yet; run POST /api/recon/:entry_id first",
      },
      { status: 409 },
    );
  }

  // Validate every pidno against the rankings JSONB; collect the denormalized
  // protoForm for each so we can write it directly into the pick row.
  const rankings = (recon.rankings as Ranking[]) ?? [];
  const protoByPidno = new Map<number, string>();
  for (const r of rankings) {
    protoByPidno.set(r.pidno, r.proto_form);
  }
  for (const p of body.picks) {
    if (!protoByPidno.has(p.pidno)) {
      return NextResponse.json(
        { error: `pidno ${p.pidno} is not in this reconstruction's rankings` },
        { status: 400 },
      );
    }
  }

  // Transactional replace: delete all picks for this entry, insert the new
  // set, update the entry's notes. drizzle-orm/postgres-js exposes db.transaction.
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.entryReconstructionPicks)
      .where(eq(schema.entryReconstructionPicks.entryId, entryId));

    if (body.picks.length > 0) {
      await tx.insert(schema.entryReconstructionPicks).values(
        body.picks.map((p) => ({
          entryId,
          reconstructionId: recon.id,
          pidno: p.pidno,
          protoForm: protoByPidno.get(p.pidno) ?? "",
          isPrimary: p.isPrimary,
        })),
      );
    }

    await tx
      .update(schema.entries)
      .set({ notes: body.notes, updatedAt: new Date() })
      .where(eq(schema.entries.id, entryId));
  });

  // Re-read the saved state (consistent with GET shape).
  const picks = await db
    .select()
    .from(schema.entryReconstructionPicks)
    .where(eq(schema.entryReconstructionPicks.entryId, entryId));

  return NextResponse.json(toReconDto(recon, picks, body.notes));
}
