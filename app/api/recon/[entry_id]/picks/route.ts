import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
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
  // Optional in the body — defaults to "ai" since the recon panel's
  // candidate list (the original PUT consumer) is the AI-source path.
  // Manual picks made via the /dictionary flow that the annotator
  // later edits via Save retain "manual" by passing it explicitly.
  source: z.enum(["ai", "manual"]).optional(),
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
  source: "ai" | "manual";
}

interface ReconResponseDto {
  entry: {
    id: number;
    page: number;
    entryIdx: number;
    text: string;
    glossRaw: string;
    state: string;
  };
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
  entry: {
    id: number;
    page: number;
    entryIdx: number;
    text: string;
    glossRaw: string;
    state: string;
  },
  row: ReconstructionRow,
  picks: PickRow[],
  entryNotes: string | null,
): ReconResponseDto {
  return {
    entry: {
      id: entry.id,
      page: entry.page,
      entryIdx: entry.entryIdx,
      text: entry.text,
      glossRaw: entry.glossRaw,
      state: entry.state,
    },
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
      source: (p.source === "manual" ? "manual" : "ai") as "ai" | "manual",
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
      page: schema.entries.page,
      entryIdx: schema.entries.entryIdx,
      text: schema.entries.text,
      glossRaw: schema.entries.glossRaw,
      state: schema.entries.state,
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

  // Each pick carries an optional source. AI picks (default) must appear
  // in the reconstruction's rankings JSONB. Manual picks must instead
  // exist in the full ACD corpus (acd_reconstructions); they came in via
  // the /dictionary browse path and don't necessarily appear in the AI's
  // shortlist. Look up proto-form denormalization in whichever table
  // applies so the pick row can be inserted with proto_form populated.
  const rankings = (recon.rankings as Ranking[]) ?? [];
  const protoByAiPidno = new Map<number, string>();
  for (const r of rankings) {
    protoByAiPidno.set(r.pidno, r.proto_form);
  }
  const manualPidnos = body.picks
    .filter((p) => p.source === "manual")
    .map((p) => p.pidno);
  const acdRows =
    manualPidnos.length === 0
      ? []
      : await db
          .select({
            pidno: schema.acdReconstructions.pidno,
            form: schema.acdReconstructions.form,
          })
          .from(schema.acdReconstructions)
          .where(inArray(schema.acdReconstructions.pidno, manualPidnos));
  const protoByManualPidno = new Map<number, string>(
    acdRows.map((r) => [r.pidno, r.form]),
  );
  for (const p of body.picks) {
    const source = p.source ?? "ai";
    if (source === "ai" && !protoByAiPidno.has(p.pidno)) {
      return NextResponse.json(
        {
          error: `AI pick pidno ${p.pidno} is not in this reconstruction's rankings`,
        },
        { status: 400 },
      );
    }
    if (source === "manual" && !protoByManualPidno.has(p.pidno)) {
      return NextResponse.json(
        { error: `manual pick pidno ${p.pidno} not found in ACD corpus` },
        { status: 400 },
      );
    }
  }

  // Transactional replace: delete all picks for this entry then re-insert
  // the unified set carrying the annotator's full pick state (AI + manual).
  // Source is preserved per pick so a later read can re-render the two
  // groups separately in the panel.
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.entryReconstructionPicks)
      .where(eq(schema.entryReconstructionPicks.entryId, entryId));

    if (body.picks.length > 0) {
      await tx.insert(schema.entryReconstructionPicks).values(
        body.picks.map((p) => {
          const source = p.source ?? "ai";
          const protoForm =
            source === "ai"
              ? protoByAiPidno.get(p.pidno) ?? ""
              : protoByManualPidno.get(p.pidno) ?? "";
          return {
            entryId,
            reconstructionId: source === "ai" ? recon.id : null,
            pidno: p.pidno,
            protoForm,
            isPrimary: p.isPrimary,
            source,
          };
        }),
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

  return NextResponse.json(toReconDto(entry, recon, picks, body.notes));
}
