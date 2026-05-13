import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { normalizeText, normalizeGloss } from "@/lib/recon/normalize";
import { type Ranking } from "@/lib/recon/rankings-schema";
import {
  type ActiveJobDto,
  loadActiveJob,
  loadJobPosition,
} from "@/lib/recon/jobs";

// GET  -> cache row + picks + entry meta + activeJob (if any)
// POST -> enqueue a job in recon_jobs; worker picks it up async

const CANONICAL_MODEL_ID = "claude-opus-4-7";
const CANONICAL_PROMPT_VERSION = "v2-agent";

type ReconstructionRow = typeof schema.reconstructions.$inferSelect;
type PickRow = typeof schema.entryReconstructionPicks.$inferSelect;

interface SpreadsheetProtos {
  pan?: string | null;
  pmp?: string | null;
  pcph?: string | null;
  pb?: string | null;
  status?: string | null;
  notes?: string | null;
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
    rankings: (Ranking & { totalReflexCount: number })[];
    status: string;
    errorMsg: string | null;
    computedAt: string;
    looseMatch: boolean;
    computedAgainstState: string | null;
  } | null;
  picks: {
    id: number;
    pidno: number;
    protoForm: string;
    isPrimary: boolean;
    source: "ai" | "manual";
    protoCode: string | null;
    glossText: string | null;
    setNum: number | null;
    reflexCount: number | null;
  }[];
  entryNotes: string | null;
  spreadsheetProtos: SpreadsheetProtos | null;
  activeJob: ActiveJobDto | null;
}

function parseEntryId(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function loadEntry(entryId: number) {
  const [entry] = await db
    .select({
      id: schema.entries.id,
      page: schema.entries.page,
      entryIdx: schema.entries.entryIdx,
      text: schema.entries.text,
      glossRaw: schema.entries.glossRaw,
      state: schema.entries.state,
      notes: schema.entries.notes,
      spreadsheetProtos: schema.entries.spreadsheetProtos,
    })
    .from(schema.entries)
    .where(eq(schema.entries.id, entryId));
  return entry ?? null;
}

async function loadReconstructionStrict(
  text: string,
  gloss: string,
): Promise<ReconstructionRow | null> {
  const [row] = await db
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
  return row ?? null;
}

async function loadReconstructionWithFallback(
  text: string,
  gloss: string,
): Promise<{ row: ReconstructionRow | null; looseMatch: boolean }> {
  const strict = await loadReconstructionStrict(text, gloss);
  if (strict) return { row: strict, looseMatch: false };
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
  if (loose.length === 1) return { row: loose[0], looseMatch: true };
  return { row: null, looseMatch: false };
}

async function loadPicks(entryId: number): Promise<PickRow[]> {
  return db
    .select()
    .from(schema.entryReconstructionPicks)
    .where(eq(schema.entryReconstructionPicks.entryId, entryId));
}

async function loadReflexCounts(
  pidnos: number[],
): Promise<Map<number, number>> {
  if (pidnos.length === 0) return new Map();
  const rows = await db
    .select({
      pidno: schema.acdReflexes.pidno,
      n: sql<number>`COUNT(*)::int`.as("n"),
    })
    .from(schema.acdReflexes)
    .where(inArray(schema.acdReflexes.pidno, pidnos))
    .groupBy(schema.acdReflexes.pidno);
  return new Map(rows.map((r) => [r.pidno, r.n]));
}

async function loadAcdMeta(pidnos: number[]) {
  if (pidnos.length === 0) {
    return new Map<number, { protoCode: string; glossText: string; setNum: number }>();
  }
  const rows = await db
    .select({
      pidno: schema.acdReconstructions.pidno,
      protoCode: schema.acdReconstructions.protoCode,
      glossText: schema.acdReconstructions.glossText,
      setNum: schema.acdReconstructions.setNum,
    })
    .from(schema.acdReconstructions)
    .where(inArray(schema.acdReconstructions.pidno, pidnos));
  return new Map(rows.map((r) => [r.pidno, r]));
}

function pidnosFromRow(row: ReconstructionRow | null): number[] {
  if (!row) return [];
  const rankings = (row.rankings as Ranking[]) ?? [];
  return rankings.map((r) => r.pidno).filter((n) => Number.isFinite(n));
}

function toDto(
  entry: {
    id: number;
    page: number;
    entryIdx: number;
    text: string;
    glossRaw: string;
    state: string;
  },
  row: ReconstructionRow | null,
  picks: PickRow[],
  entryNotes: string | null,
  spreadsheetProtos: SpreadsheetProtos | null,
  reflexCountByPidno: Map<number, number>,
  manualPickMeta: Map<
    number,
    { protoCode: string; glossText: string; setNum: number }
  >,
  activeJob: ActiveJobDto | null,
  looseMatch = false,
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
    reconstruction: row
      ? {
          id: row.id,
          text: row.text,
          gloss: row.gloss,
          modelId: row.modelId,
          promptVersion: row.promptVersion,
          schemaVersion: row.schemaVersion,
          rankings: (row.rankings as Ranking[]).map((r) => ({
            ...r,
            totalReflexCount: reflexCountByPidno.get(r.pidno) ?? 0,
          })),
          status: row.status,
          errorMsg: row.errorMsg,
          computedAt: row.computedAt.toISOString(),
          looseMatch,
          computedAgainstState: row.computedAgainstState ?? null,
        }
      : null,
    picks: picks.map((p) => {
      const source = (p.source === "manual" ? "manual" : "ai") as "ai" | "manual";
      const meta = source === "manual" ? manualPickMeta.get(p.pidno) : null;
      return {
        id: p.id,
        pidno: p.pidno,
        protoForm: p.protoForm,
        isPrimary: p.isPrimary,
        source,
        protoCode: meta?.protoCode ?? null,
        glossText: meta?.glossText ?? null,
        setNum: meta?.setNum ?? null,
        reflexCount:
          source === "manual" ? reflexCountByPidno.get(p.pidno) ?? 0 : null,
      };
    }),
    entryNotes,
    spreadsheetProtos,
    activeJob,
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { entry_id: string } },
) {
  const entryId = parseEntryId(params.entry_id);
  if (entryId === null) {
    return NextResponse.json({ error: "bad entry_id" }, { status: 400 });
  }
  const entry = await loadEntry(entryId);
  if (!entry) {
    return NextResponse.json({ error: "entry not found" }, { status: 404 });
  }
  const text = normalizeText(entry.text);
  const gloss = normalizeGloss(entry.glossRaw);
  const { row: recon, looseMatch } = await loadReconstructionWithFallback(text, gloss);
  const picks = await loadPicks(entryId);
  const reflexCountTargets = Array.from(
    new Set<number>([
      ...pidnosFromRow(recon),
      ...picks.map((p) => p.pidno),
    ]),
  );
  const reflexCounts = await loadReflexCounts(reflexCountTargets);
  const manualPidnos = picks
    .filter((p) => p.source === "manual")
    .map((p) => p.pidno);
  const manualPickMeta = await loadAcdMeta(manualPidnos);
  const activeJob = await loadActiveJob(entryId);
  return NextResponse.json(
    toDto(
      entry,
      recon,
      picks,
      entry.notes,
      entry.spreadsheetProtos as SpreadsheetProtos | null,
      reflexCounts,
      manualPickMeta,
      activeJob,
      looseMatch,
    ),
  );
}

interface EnqueueResponse {
  jobId: number;
  status: "pending" | "running" | "done" | "error";
  position: number | null;
  reusedExisting: boolean;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { entry_id: string } },
) {
  const entryId = parseEntryId(params.entry_id);
  if (entryId === null) {
    return NextResponse.json({ error: "bad entry_id" }, { status: 400 });
  }
  const entry = await loadEntry(entryId);
  if (!entry) {
    return NextResponse.json({ error: "entry not found" }, { status: 404 });
  }
  const text = normalizeText(entry.text);
  const gloss = normalizeGloss(entry.glossRaw);
  if (!text) {
    return NextResponse.json({ error: "entry has empty text" }, { status: 400 });
  }
  const forceParam = req.nextUrl.searchParams.get("force");
  const force = forceParam === "1" || forceParam === "true";

  if (!force) {
    const existing = await loadReconstructionStrict(text, gloss);
    if (existing && existing.status === "done") {
      return NextResponse.json(
        {
          error: "reconstruction already exists; refresh via GET",
          reconstructionId: existing.id,
        },
        { status: 409 },
      );
    }
  }

  // If an active job already exists for this entry, reuse it. The
  // partial unique index on entry_id WHERE status IN (pending,running)
  // would otherwise reject the INSERT.
  const existingJob = await loadActiveJob(entryId);
  if (existingJob) {
    const body: EnqueueResponse = {
      jobId: existingJob.id,
      status: existingJob.status,
      position: existingJob.position,
      reusedExisting: true,
    };
    return NextResponse.json(body, { status: 202 });
  }

  const [inserted] = await db
    .insert(schema.reconJobs)
    .values({
      entryId,
      text,
      gloss,
      entryStateAtEnqueue: entry.state,
      status: "pending",
    })
    .returning();

  const position = await loadJobPosition(inserted);
  const body: EnqueueResponse = {
    jobId: inserted.id,
    status: "pending",
    position,
    reusedExisting: false,
  };
  return NextResponse.json(body, { status: 202 });
}
