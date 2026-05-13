import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { normalizeText, normalizeGloss } from "@/lib/recon/normalize";
import {
  RANKINGS_PAYLOAD,
  type RankingsPayload,
  type Ranking,
} from "@/lib/recon/rankings-schema";

/**
 * Reconstruction cache + compute endpoints.
 *
 *   GET  /api/recon/:entry_id  -> cached row for this entry's (text, gloss),
 *                                 plus the entry's picks and freeform notes.
 *                                 200 with { reconstruction: null, ... } on
 *                                 cache miss; 404 only if the entry itself
 *                                 doesn't exist.
 *
 *   POST /api/recon/:entry_id  -> "Attempt with AI". Forwards to the Python
 *                                 reconstruction service, validates the
 *                                 response, INSERTs into Postgres, returns
 *                                 the same shape as GET. 409 if a done row
 *                                 already exists (caller should re-fetch).
 */

const CANONICAL_MODEL_ID = "claude-opus-4-7";
const CANONICAL_PROMPT_VERSION = "v2-agent";

const PYTHON_SERVICE_URL =
  process.env.RECONSTRUCTION_SERVICE_URL ?? "http://localhost:8000";

// Claude agent loops can take ~30s; allow 90s to be safe.
const PYTHON_FETCH_TIMEOUT_MS = 90_000;

type ReconstructionRow = typeof schema.reconstructions.$inferSelect;
type PickRow = typeof schema.entryReconstructionPicks.$inferSelect;

export interface SpreadsheetProtos {
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
    rankings: (Ranking & {
      /**
       * Total reflex count for this pidno in the full ACD corpus
       * (acd_reflexes table). Distinct from sample_reflexes.length,
       * which was capped at 5 by the agent at ranking-time to keep its
       * tool-result payloads tight. The UI surfaces this so the reflex
       * count badge reflects truth, not the sample subset.
       */
      totalReflexCount: number;
    })[];
    status: string;
    errorMsg: string | null;
    computedAt: string;
    /**
     * True when the row was found by text-only fallback (the strict
     * text+gloss lookup missed). Happens when the cached gloss came from a
     * different source than the labeler's gloss — e.g. the bench input.json
     * gloss was a subset of the spreadsheet's enriched gloss. The UI should
     * surface a small "loose match" indicator so the annotator knows the
     * ranking was originally computed against a different gloss spelling.
     */
    looseMatch: boolean;
  } | null;
  picks: {
    id: number;
    pidno: number;
    protoForm: string;
    isPrimary: boolean;
    source: "ai" | "manual";
    /**
     * Enrichment fields populated for manual picks (those that came in
     * via the /dictionary append path and aren't in the AI rankings).
     * The panel uses these to render a card with proto-code, gloss and
     * reflex count rather than just a bare proto-form. AI picks leave
     * these null because the same data already lives in
     * reconstruction.rankings[N].
     */
    protoCode: string | null;
    glossText: string | null;
    setNum: number | null;
    reflexCount: number | null;
  }[];
  entryNotes: string | null;
  spreadsheetProtos: SpreadsheetProtos | null;
}

function parseEntryId(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
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
        reflexCount: source === "manual"
          ? reflexCountByPidno.get(p.pidno) ?? 0
          : null,
      };
    }),
    entryNotes,
    spreadsheetProtos,
  };
}

/**
 * Look up the true reflex count for each pidno in a list, against the
 * full ACD corpus (acd_reflexes). Returns a map keyed by pidno; pidnos
 * with zero reflexes (or unknown to the corpus) are absent — callers
 * default to 0.
 */
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

function pidnosFromRow(row: ReconstructionRow | null): number[] {
  if (!row) return [];
  const rankings = (row.rankings as Ranking[]) ?? [];
  return rankings.map((r) => r.pidno).filter((n) => Number.isFinite(n));
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
  // Fallback: same text, ANY gloss under the canonical model+prompt. Only
  // use the fallback if exactly one row exists; multiple rows would be
  // ambiguous, so treat as miss in that case.
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
    return { row: loose[0], looseMatch: true };
  }
  return { row: null, looseMatch: false };
}

async function loadPicks(entryId: number): Promise<PickRow[]> {
  return db
    .select()
    .from(schema.entryReconstructionPicks)
    .where(eq(schema.entryReconstructionPicks.entryId, entryId));
}

/**
 * Look up acd_reconstructions metadata (proto_code, gloss, set_num) for
 * a list of pidnos — used to enrich manual picks so the panel can show
 * them as full cards rather than bare proto-form chips.
 */
async function loadAcdMeta(pidnos: number[]) {
  if (pidnos.length === 0) return new Map<number, { protoCode: string; glossText: string; setNum: number }>();
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
  // Reflex counts cover BOTH AI candidates (from rankings) and manual
  // picks (from picks) so the panel can render true counts uniformly.
  const reflexCountTargets = Array.from(
    new Set<number>([
      ...pidnosFromRow(recon),
      ...picks.map((p) => p.pidno),
    ]),
  );
  const reflexCounts = await loadReflexCounts(reflexCountTargets);
  // Enrichment for manual picks: pull proto_code / gloss / set_num from
  // acd_reconstructions so the panel can render them as full cards.
  const manualPidnos = picks
    .filter((p) => p.source === "manual")
    .map((p) => p.pidno);
  const manualPickMeta = await loadAcdMeta(manualPidnos);
  return NextResponse.json(
    toDto(
      entry,
      recon,
      picks,
      entry.notes,
      entry.spreadsheetProtos as SpreadsheetProtos | null,
      reflexCounts,
      manualPickMeta,
      looseMatch,
    ),
  );
}

async function callPythonService(
  text: string,
  gloss: string,
): Promise<RankingsPayload> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PYTHON_FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${PYTHON_SERVICE_URL}/reconstruct`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, gloss }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new ServiceUnreachableError(
      `Python reconstruction service at ${PYTHON_SERVICE_URL} is unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new ServiceErrorResponse(
      `Python service returned ${res.status}: ${body.slice(0, 500)}`,
      res.status,
    );
  }
  const json = await res.json();
  // The Python service nests the payload alongside cache_hit / persistence
  // fields. Accept either the bare payload or the wrapped shape.
  const candidate = json?.payload ?? json;
  return RANKINGS_PAYLOAD.parse(candidate);
}

class ServiceUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceUnreachableError";
  }
}

class ServiceErrorResponse extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "ServiceErrorResponse";
  }
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

  // ?force=1 means "re-run the AI even if a cached row exists" — used by
  // the re-run-with-AI button when the annotator wants a fresh take on a
  // word that already has rankings. Without it, an existing done row
  // returns 409 so the caller refreshes via GET.
  const forceParam = req.nextUrl.searchParams.get("force");
  const force = forceParam === "1" || forceParam === "true";

  if (!force) {
    // Strict lookup so a loose-match row doesn't 409 a request that's
    // really aimed at a different gloss spelling.
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

  let payload: RankingsPayload;
  try {
    payload = await callPythonService(text, gloss);
  } catch (err) {
    if (err instanceof ServiceUnreachableError) {
      return NextResponse.json(
        {
          error:
            "AI reconstruction service is offline. Ask the admin to start it (uvicorn service.app.main:app --port 8000) and try again.",
        },
        { status: 503 },
      );
    }
    if (err instanceof ServiceErrorResponse) {
      return NextResponse.json(
        { error: `AI service returned an error: ${err.message}` },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: `AI service returned malformed data: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  // Force re-run: UPDATE in place on conflict so the row's id (and the
  // FKs from existing AI picks) survive. Non-force path: keep the
  // existing row on conflict.
  const conflictTarget = [
    schema.reconstructions.text,
    schema.reconstructions.gloss,
    schema.reconstructions.modelId,
    schema.reconstructions.promptVersion,
  ];
  const insert = db
    .insert(schema.reconstructions)
    .values({
      text,
      gloss,
      modelId: payload.model_id,
      promptVersion: payload.prompt_template_version,
      schemaVersion: payload.schema_version,
      rankings: payload.rankings,
      status: "done",
      errorMsg: null,
    });
  const [row] = await (force
    ? insert.onConflictDoUpdate({
        target: conflictTarget,
        set: {
          schemaVersion: payload.schema_version,
          rankings: payload.rankings,
          status: "done",
          errorMsg: null,
          computedAt: new Date(),
        },
      })
    : insert.onConflictDoNothing({ target: conflictTarget })
  ).returning();

  const saved = row ?? (await loadReconstructionStrict(text, gloss));
  const picks = await loadPicks(entryId);
  const reflexCountTargets = Array.from(
    new Set<number>([
      ...pidnosFromRow(saved),
      ...picks.map((p) => p.pidno),
    ]),
  );
  const reflexCounts = await loadReflexCounts(reflexCountTargets);
  const manualPidnos = picks
    .filter((p) => p.source === "manual")
    .map((p) => p.pidno);
  const manualPickMeta = await loadAcdMeta(manualPidnos);
  return NextResponse.json(
    toDto(
      entry,
      saved,
      picks,
      entry.notes,
      entry.spreadsheetProtos as SpreadsheetProtos | null,
      reflexCounts,
      manualPickMeta,
    ),
    { status: force ? 200 : 201 },
  );
}
