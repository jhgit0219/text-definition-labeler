import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

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
  }[];
  entryNotes: string | null;
  spreadsheetProtos: SpreadsheetProtos | null;
}

function parseEntryId(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toDto(
  entry: { id: number; text: string; glossRaw: string; state: string },
  row: ReconstructionRow | null,
  picks: PickRow[],
  entryNotes: string | null,
  spreadsheetProtos: SpreadsheetProtos | null,
  looseMatch = false,
): ReconResponseDto {
  return {
    entry: {
      id: entry.id,
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
          rankings: row.rankings as Ranking[],
          status: row.status,
          errorMsg: row.errorMsg,
          computedAt: row.computedAt.toISOString(),
          looseMatch,
        }
      : null,
    picks: picks.map((p) => ({
      id: p.id,
      pidno: p.pidno,
      protoForm: p.protoForm,
      isPrimary: p.isPrimary,
    })),
    entryNotes,
    spreadsheetProtos,
  };
}

async function loadEntry(entryId: number) {
  const [entry] = await db
    .select({
      id: schema.entries.id,
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
  return NextResponse.json(
    toDto(entry, recon, picks, entry.notes, entry.spreadsheetProtos as SpreadsheetProtos | null, looseMatch),
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

  // Pre-check: if a done row already exists, surface 409 so the caller can
  // re-fetch via GET. Race-safe because of the UNIQUE constraint — but
  // checking first gives a nicer error than catching a duplicate-key.
  // Use strict lookup here so we don't 409 on a loose-match row that's
  // really for a different gloss spelling.
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

  // INSERT, taking the existing row on UNIQUE violation (the Python service
  // also dual-writes; whichever lands first wins).
  const [row] = await db
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
    })
    .onConflictDoNothing({
      target: [
        schema.reconstructions.text,
        schema.reconstructions.gloss,
        schema.reconstructions.modelId,
        schema.reconstructions.promptVersion,
      ],
    })
    .returning();

  const saved = row ?? (await loadReconstructionStrict(text, gloss));
  const picks = await loadPicks(entryId);
  return NextResponse.json(
    toDto(entry, saved, picks, entry.notes, entry.spreadsheetProtos as SpreadsheetProtos | null),
    { status: 201 },
  );
}
