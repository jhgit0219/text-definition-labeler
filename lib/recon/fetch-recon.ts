import {
  RANKINGS_PAYLOAD,
  type RankingsPayload,
  type Ranking,
} from "./rankings-schema";

/**
 * Typed wrappers around the Next.js reconstruction API surface. The UI
 * imports these so the Postgres -> Python -> Postgres data flow is
 * exercised through a single Zod-validated entry point.
 *
 * The response shape from /api/recon/[entry_id] differs from the raw
 * RankingsPayload by also carrying picks and entry-level notes. Picks
 * land in their own table; the embedded RankingsPayload is the AI side.
 */
export interface ReconstructionPickDto {
  id: number;
  pidno: number;
  protoForm: string;
  isPrimary: boolean;
  /**
   * Where the pick came from. "ai" = ticked in the recon panel's
   * candidate list (the AI ranking shortlist). "manual" = added from
   * the /dictionary browse path, which means the pidno may NOT appear
   * in the current rankings JSONB. The UI renders the two sources in
   * separate sections so manual picks stay visible even when they have
   * no matching AI candidate row.
   */
  source: "ai" | "manual";
  /**
   * Enrichment fields populated only for `source: 'manual'` picks.
   * AI picks leave these null because the same data is already in the
   * embedded rankings list.
   */
  protoCode: string | null;
  glossText: string | null;
  setNum: number | null;
  reflexCount: number | null;
}

/**
 * A `Ranking` from the schema plus the true total reflex count for that
 * pidno in the ACD corpus. The agent's stored `sample_reflexes` array is
 * capped at 5 by the iter-5 ranker — `totalReflexCount` is the truth
 * read from `acd_reflexes` at GET time.
 */
export type RankingWithCount = Ranking & { totalReflexCount: number };

export interface ReconstructionRowDto {
  id: number;
  text: string;
  gloss: string;
  modelId: string;
  promptVersion: string;
  schemaVersion: number;
  rankings: RankingWithCount[];
  status: "queued" | "done" | "error";
  errorMsg: string | null;
  computedAt: string; // ISO timestamp
  /**
   * True when the row was found via text-only fallback (the strict
   * text+gloss lookup missed). UI surfaces a small "loose match" indicator
   * so the annotator knows the ranking was originally computed against a
   * slightly different gloss spelling.
   */
  looseMatch?: boolean;
  /**
   * State of the originating entry when the reconstruction was computed.
   * When non-null and != 'accepted', the panel renders a banner: the
   * ranking was generated pre-validation and the annotator should
   * sanity-check the text/gloss before committing picks.
   */
  computedAgainstState?: string | null;
}

export interface SpreadsheetProtosDto {
  pan?: string | null;
  pmp?: string | null;
  pcph?: string | null;
  pb?: string | null;
  status?: string | null;
  notes?: string | null;
}

export interface ReconResponseDto {
  entry: {
    id: number;
    page: number;
    entryIdx: number;
    text: string;
    glossRaw: string;
    state: string;
  };
  reconstruction: ReconstructionRowDto | null;
  picks: ReconstructionPickDto[];
  entryNotes: string | null;
  spreadsheetProtos: SpreadsheetProtosDto | null;
}

export class ReconError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "ReconError";
  }
}

async function parseResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const msg =
      (body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `HTTP ${res.status}`);
    throw new ReconError(msg, res.status, body);
  }
  return body as T;
}

/** GET /api/recon/[entry_id] — cache lookup; 200 with reconstruction=null on miss. */
export async function fetchReconstruction(
  entryId: number,
): Promise<ReconResponseDto> {
  const res = await fetch(`/api/recon/${entryId}`, { method: "GET" });
  const body = await parseResponse<ReconResponseDto>(res);
  if (body.reconstruction) {
    // Validate the embedded rankings shape — guards against schema drift.
    RANKINGS_PAYLOAD.parse({
      schema_version: body.reconstruction.schemaVersion,
      rankings: body.reconstruction.rankings,
      model_id: body.reconstruction.modelId,
      prompt_template_version: body.reconstruction.promptVersion,
    });
  }
  return body;
}

/**
 * POST /api/recon/[entry_id] — "Attempt with AI".
 *
 * Default behavior 409s if a cached row already exists (caller should
 * refresh via GET). Pass `force: true` to bypass the check and UPDATE the
 * cached row with a fresh AI ranking — used by the re-run button when
 * the annotator wants a new take on an already-ranked word. Existing AI
 * picks survive because the reconstruction row's id (the FK target)
 * doesn't change.
 */
export async function runReconstruction(
  entryId: number,
  opts: { force?: boolean } = {},
): Promise<ReconResponseDto> {
  const url = opts.force
    ? `/api/recon/${entryId}?force=1`
    : `/api/recon/${entryId}`;
  const res = await fetch(url, { method: "POST" });
  const body = await parseResponse<ReconResponseDto>(res);
  if (body.reconstruction) {
    RANKINGS_PAYLOAD.parse({
      schema_version: body.reconstruction.schemaVersion,
      rankings: body.reconstruction.rankings,
      model_id: body.reconstruction.modelId,
      prompt_template_version: body.reconstruction.promptVersion,
    });
  }
  return body;
}

/** PUT /api/recon/[entry_id]/picks — replace pick set + notes transactionally. */
export interface PickInput {
  pidno: number;
  isPrimary: boolean;
  /** Defaults to "ai" server-side; pass explicitly for manual picks. */
  source?: "ai" | "manual";
}

export async function savePicks(
  entryId: number,
  picks: PickInput[],
  notes: string | null,
): Promise<ReconResponseDto> {
  const res = await fetch(`/api/recon/${entryId}/picks`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ picks, notes }),
  });
  return parseResponse<ReconResponseDto>(res);
}

export type { RankingsPayload };
