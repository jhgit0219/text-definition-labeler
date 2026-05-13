"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Sparkles,
  Star,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { groupBySubgroup } from "@/lib/recon/subgroups";
import {
  fetchReconstruction,
  runReconstruction,
  savePicks,
  ReconError,
  type ReconResponseDto,
  type ReconstructionPickDto,
  type ReconstructionRowDto,
  type SpreadsheetProtosDto,
  type PickInput,
} from "@/lib/recon/fetch-recon";
import type { Ranking } from "@/lib/recon/rankings-schema";

interface Entry {
  id: number;
  text: string;
  glossRaw: string;
  state: string;
}

interface Props {
  entry: Entry | null;
  /** Opens the dictionary drawer over the review page. When omitted the
   *  panel falls back to a Next.js Link to /dictionary?entry_id=N. */
  onBrowseAcd?: (initialPrefix: string) => void;
  /** Bump from the parent to force the panel to re-fetch its data —
   *  used after a drawer interaction lands a pick or note via the
   *  cross-component API. */
  reloadKey?: number;
}

type PanelState =
  | { kind: "no-entry" }
  | { kind: "not-accepted"; entry: Entry }
  | { kind: "loading"; entry: Entry }
  | { kind: "miss"; entry: Entry; spreadsheet: SpreadsheetProtosDto | null }
  | { kind: "queued"; entry: Entry }
  | { kind: "done"; entry: Entry; data: ReconResponseDto }
  | { kind: "error"; entry: Entry; message: string };

export function ReconstructionPanel({
  entry,
  onBrowseAcd,
  reloadKey,
}: Props) {
  const [state, setState] = useState<PanelState>({ kind: "no-entry" });
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  // Form state that overlays the fetched picks/notes — lets the user toggle
  // without round-tripping every keystroke.
  const [draftPicks, setDraftPicks] = useState<PickInput[]>([]);
  const [draftNotes, setDraftNotes] = useState<string>("");
  const [savedSnapshot, setSavedSnapshot] = useState<{
    picks: PickInput[];
    notes: string;
  } | null>(null);

  // Track which entry ID's data we hold so we don't apply stale fetches.
  const activeEntryRef = useRef<number | null>(null);

  useEffect(() => {
    if (!entry) {
      setState({ kind: "no-entry" });
      activeEntryRef.current = null;
      return;
    }
    if (entry.state !== "accepted") {
      setState({ kind: "not-accepted", entry });
      activeEntryRef.current = entry.id;
      return;
    }
    activeEntryRef.current = entry.id;
    setState({ kind: "loading", entry });
    fetchReconstruction(entry.id)
      .then((data) => {
        if (activeEntryRef.current !== entry.id) return;
        if (data.reconstruction === null) {
          setState({
            kind: "miss",
            entry,
            spreadsheet: data.spreadsheetProtos,
          });
          setDraftPicks([]);
          setDraftNotes(data.entryNotes ?? "");
          setSavedSnapshot({ picks: [], notes: data.entryNotes ?? "" });
          return;
        }
        if (data.reconstruction.status === "queued") {
          setState({ kind: "queued", entry });
          return;
        }
        const initialPicks: PickInput[] = data.picks.map((p) => ({
          pidno: p.pidno,
          isPrimary: p.isPrimary,
          source: p.source,
        }));
        setDraftPicks(initialPicks);
        setDraftNotes(data.entryNotes ?? "");
        setSavedSnapshot({ picks: initialPicks, notes: data.entryNotes ?? "" });
        setState({ kind: "done", entry, data });
      })
      .catch((err) => {
        if (activeEntryRef.current !== entry.id) return;
        setState({
          kind: "error",
          entry,
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, [entry?.id, entry?.state, reloadKey]);

  const dirty = useMemo(() => {
    if (!savedSnapshot) return false;
    if (draftNotes !== savedSnapshot.notes) return true;
    if (draftPicks.length !== savedSnapshot.picks.length) return true;
    const a = sortPicks(draftPicks);
    const b = sortPicks(savedSnapshot.picks);
    for (let i = 0; i < a.length; i++) {
      if (
        a[i].pidno !== b[i].pidno ||
        a[i].isPrimary !== b[i].isPrimary ||
        (a[i].source ?? "ai") !== (b[i].source ?? "ai")
      ) {
        return true;
      }
    }
    return false;
  }, [draftPicks, draftNotes, savedSnapshot]);

  async function onAttempt(opts: { force?: boolean } = {}) {
    if (state.kind !== "miss" && state.kind !== "done") return;
    const targetEntry = state.entry;
    setRunning(true);
    try {
      const data = await runReconstruction(targetEntry.id, opts);
      if (activeEntryRef.current !== targetEntry.id) return;
      if (data.reconstruction) {
        const initialPicks: PickInput[] = data.picks.map((p) => ({
          pidno: p.pidno,
          isPrimary: p.isPrimary,
          source: p.source,
        }));
        setDraftPicks(initialPicks);
        setDraftNotes(data.entryNotes ?? "");
        setSavedSnapshot({ picks: initialPicks, notes: data.entryNotes ?? "" });
        setState({ kind: "done", entry: targetEntry, data });
      }
    } catch (err) {
      const msg =
        err instanceof ReconError && err.status === 409
          ? "Reconstruction already exists for this word — refreshing."
          : err instanceof Error
            ? err.message
            : String(err);
      setState({ kind: "error", entry: targetEntry, message: msg });
    } finally {
      setRunning(false);
    }
  }

  async function onSave() {
    if (state.kind !== "done") return;
    setSaving(true);
    try {
      const data = await savePicks(state.entry.id, draftPicks, draftNotes || null);
      const initialPicks: PickInput[] = data.picks.map((p) => ({
        pidno: p.pidno,
        isPrimary: p.isPrimary,
        source: p.source,
      }));
      setSavedSnapshot({ picks: initialPicks, notes: data.entryNotes ?? "" });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState({ kind: "error", entry: state.entry, message: msg });
    } finally {
      setSaving(false);
    }
  }

  function togglePick(pidno: number) {
    setDraftPicks((prev) => {
      const idx = prev.findIndex((p) => p.pidno === pidno);
      if (idx >= 0) {
        const next = prev.filter((p) => p.pidno !== pidno);
        // If we just removed the primary, promote the first remaining pick
        // so the "exactly one primary if anything is picked" invariant holds.
        if (prev[idx].isPrimary && next.length > 0 && !next.some((p) => p.isPrimary)) {
          next[0] = { ...next[0], isPrimary: true };
        }
        return next;
      }
      // Adding: first pick is primary; subsequent picks aren't unless they
      // tap the star. Source defaults to "ai" here — togglePick is wired
      // to the AI-candidate row in the panel, so it only adds AI picks.
      // Manual picks land via the /dictionary append endpoint.
      const isPrimary = prev.length === 0;
      return [...prev, { pidno, isPrimary, source: "ai" }];
    });
  }

  function setPrimary(pidno: number) {
    setDraftPicks((prev) => {
      const exists = prev.some((p) => p.pidno === pidno);
      if (!exists) {
        // Starring an unchecked candidate also checks it.
        return [
          ...prev.map((p) => ({ ...p, isPrimary: false })),
          { pidno, isPrimary: true, source: "ai" as const },
        ];
      }
      return prev.map((p) => ({ ...p, isPrimary: p.pidno === pidno }));
    });
  }

  // Drop a manual pick from the entry's pick set. Used by the
  // "manual picks" section that shows ACD-browse picks; they don't
  // have a checkbox in the AI candidate list to untick.
  function removeManualPick(pidno: number) {
    setDraftPicks((prev) => {
      const removed = prev.find((p) => p.pidno === pidno);
      const next = prev.filter((p) => p.pidno !== pidno);
      if (removed?.isPrimary && next.length > 0 && !next.some((p) => p.isPrimary)) {
        next[0] = { ...next[0], isPrimary: true };
      }
      return next;
    });
  }

  // Header is always rendered; only the body switches by state.
  return (
    <div className="h-full flex flex-col bg-card">
      <header className="px-4 h-14 flex items-center border-b border-border flex-shrink-0">
        <span className="text-sm font-semibold tracking-tight">
          Reconstruction
        </span>
        {state.kind === "done" && (
          <>
            <Badge className="ml-2 bg-stone-50 text-stone-700 border border-stone-300 font-normal">
              cache hit
            </Badge>
            {state.data.reconstruction?.looseMatch && (
              <Badge
                className="ml-1 bg-amber-50 text-amber-700 border border-amber-300 font-normal"
                title="Cached ranking was originally computed against a slightly different gloss spelling — same headword."
              >
                loose match
              </Badge>
            )}
          </>
        )}
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {state.kind === "no-entry" && (
          <EmptyState message="Pick an entry from the list to see its reconstruction." />
        )}
        {state.kind === "not-accepted" && (
          <EmptyState message="Reconstruction appears after the entry is accepted." />
        )}
        {state.kind === "loading" && (
          <CenteredSpinner label="Loading reconstruction…" />
        )}
        {state.kind === "miss" && (
          <MissView
            entry={state.entry}
            spreadsheet={state.spreadsheet}
            onAttempt={() => onAttempt()}
            running={running}
            onBrowseAcd={onBrowseAcd}
          />
        )}
        {state.kind === "queued" && (
          <CenteredSpinner label="Reconstructing… (this can take ~30s)" />
        )}
        {state.kind === "error" && (
          <ErrorView
            message={state.message}
            onRetry={() => {
              activeEntryRef.current = state.entry.id;
              setState({ kind: "loading", entry: state.entry });
              fetchReconstruction(state.entry.id)
                .then((data) => {
                  if (data.reconstruction) {
                    const initialPicks: PickInput[] = data.picks.map((p) => ({
                      pidno: p.pidno,
                      isPrimary: p.isPrimary,
                      source: p.source,
                    }));
                    setDraftPicks(initialPicks);
                    setDraftNotes(data.entryNotes ?? "");
                    setSavedSnapshot({
                      picks: initialPicks,
                      notes: data.entryNotes ?? "",
                    });
                    setState({ kind: "done", entry: state.entry, data });
                  } else {
                    setState({
                      kind: "miss",
                      entry: state.entry,
                      spreadsheet: data.spreadsheetProtos,
                    });
                  }
                })
                .catch((err) => {
                  setState({
                    kind: "error",
                    entry: state.entry,
                    message: err instanceof Error ? err.message : String(err),
                  });
                });
            }}
          />
        )}
        {state.kind === "done" && (
          <DoneView
            data={state.data}
            draftPicks={draftPicks}
            draftNotes={draftNotes}
            onTogglePick={togglePick}
            onSetPrimary={setPrimary}
            onRemoveManualPick={removeManualPick}
            onNotesChange={setDraftNotes}
            onBrowseAcd={onBrowseAcd}
            onRerun={() => {
              if (
                draftPicks.length > 0 &&
                !window.confirm(
                  "Re-run the AI for this word? The current rankings will be replaced. Your existing picks stay attached even if their pidno isn't in the new ranking list.",
                )
              ) {
                return;
              }
              onAttempt({ force: true });
            }}
            rerunning={running}
          />
        )}
      </div>

      {state.kind === "done" && (
        <footer className="px-4 py-3 border-t border-border flex-shrink-0 flex items-center gap-2">
          <Button
            onClick={onSave}
            disabled={!dirty || saving}
            className="flex-1"
          >
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Saving…
              </>
            ) : (
              "Save picks + notes"
            )}
          </Button>
          {savedFlash && (
            <span className="text-xs text-emerald-700 font-medium">
              Saved ✓
            </span>
          )}
        </footer>
      )}
    </div>
  );
}

function sortPicks(picks: PickInput[]): PickInput[] {
  return [...picks].sort((a, b) => a.pidno - b.pidno);
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="px-6 py-12 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function CenteredSpinner({ label }: { label: string }) {
  return (
    <div className="px-6 py-12 flex flex-col items-center gap-3 text-sm text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin" />
      <span>{label}</span>
    </div>
  );
}

function ErrorView({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="px-6 py-12 flex flex-col items-center gap-3 text-sm">
      <AlertCircle className="h-5 w-5 text-rose-600" />
      <p className="text-center text-muted-foreground">{message}</p>
      <Button onClick={onRetry} variant="outline" size="sm">
        <RefreshCw className="h-3.5 w-3.5" />
        Retry
      </Button>
    </div>
  );
}

function MissView({
  entry,
  spreadsheet,
  onAttempt,
  running,
  onBrowseAcd,
}: {
  entry: Entry;
  spreadsheet: SpreadsheetProtosDto | null;
  onAttempt: () => void;
  running: boolean;
  onBrowseAcd?: (prefix: string) => void;
}) {
  return (
    <div className="px-4 py-4 space-y-4">
      {spreadsheet && <SpreadsheetReferenceCard data={spreadsheet} />}
      <div className="border border-dashed border-border rounded p-4 text-center space-y-3">
        <p className="text-sm text-muted-foreground">
          No reconstruction yet for{" "}
          <span className="font-mono font-medium text-foreground">
            {entry.text}
          </span>{" "}
          /{" "}
          <span className="italic">
            {entry.glossRaw || "(empty gloss)"}
          </span>
          .
        </p>
        <Button onClick={onAttempt} disabled={running}>
          {running ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Calling AI…
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5" />
              Attempt with AI
            </>
          )}
        </Button>
      </div>
      <BrowseAcdLink entry={entry} onBrowseAcd={onBrowseAcd} />
    </div>
  );
}

function BrowseAcdLink({
  entry,
  onBrowseAcd,
}: {
  entry: Entry;
  onBrowseAcd?: (prefix: string) => void;
}) {
  // Default the dictionary to the 2-letter prefix matching the entry's
  // first two ASCII letters (e.g. "Babuy" -> "ba"). Falls back gracefully
  // when the entry text doesn't have two ASCII letters.
  const t = (entry.text || "").trim().toLowerCase();
  const c0 = t.charAt(0);
  const c1 = t.charAt(1);
  const a = c0 >= "a" && c0 <= "z" ? c0 : "a";
  const b = c1 >= "a" && c1 <= "z" ? c1 : "a";
  const prefix = `${a}${b}`;
  // When the parent provided a drawer-opener callback, prefer that.
  // Otherwise fall back to a full navigation to /dictionary so the panel
  // stays usable outside the /review context.
  if (onBrowseAcd) {
    return (
      <div className="pt-2 text-center">
        <button
          type="button"
          onClick={() => onBrowseAcd(prefix)}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
        >
          <BookOpen className="h-3 w-3" />
          Nothing matches? Browse the full ACD →
        </button>
      </div>
    );
  }
  return (
    <div className="pt-2 text-center">
      <Link
        href={`/dictionary?entry_id=${entry.id}&prefix=${prefix}`}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
      >
        <BookOpen className="h-3 w-3" />
        Nothing matches? Browse the full ACD →
      </Link>
    </div>
  );
}

function SpreadsheetReferenceCard({ data }: { data: SpreadsheetProtosDto }) {
  const rows: Array<[string, string | null | undefined]> = [
    ["PAN", data.pan],
    ["PMP", data.pmp],
    ["PCPh", data.pcph],
    ["PB", data.pb],
  ];
  const visibleRows = rows.filter(([, v]) => v && v.trim());
  return (
    <div className="border border-border rounded p-3 bg-stone-50">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
          Spreadsheet reference
        </span>
        {data.status && (
          <Badge className="bg-stone-100 text-stone-700 border border-stone-300 font-normal">
            {data.status}
          </Badge>
        )}
      </div>
      {visibleRows.length === 0 ? (
        <p className="text-xs italic text-muted-foreground">
          (no proto-form recorded in spreadsheet)
        </p>
      ) : (
        <dl className="space-y-1 text-xs">
          {visibleRows.map(([layer, value]) => (
            <div key={layer} className="flex gap-2">
              <dt className="w-12 text-muted-foreground tabular-nums">
                {layer}
              </dt>
              <dd className="font-mono text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {data.notes && (
        <p className="mt-2 text-xs italic text-muted-foreground">
          {data.notes}
        </p>
      )}
    </div>
  );
}

function DoneView({
  data,
  draftPicks,
  draftNotes,
  onTogglePick,
  onSetPrimary,
  onRemoveManualPick,
  onNotesChange,
  onBrowseAcd,
  onRerun,
  rerunning,
}: {
  data: ReconResponseDto;
  draftPicks: PickInput[];
  draftNotes: string;
  onTogglePick: (pidno: number) => void;
  onSetPrimary: (pidno: number) => void;
  onRemoveManualPick: (pidno: number) => void;
  onNotesChange: (s: string) => void;
  onBrowseAcd?: (prefix: string) => void;
  onRerun: () => void;
  rerunning: boolean;
}) {
  const recon = data.reconstruction!;
  const rankings = recon.rankings;
  const pickByPidno = useMemo(() => {
    const m = new Map<number, PickInput>();
    for (const p of draftPicks) m.set(p.pidno, p);
    return m;
  }, [draftPicks]);
  // Manual picks (added via /dictionary) whose pidno does NOT appear in
  // the AI rankings. These render in their own section so they stay
  // visible even though there's no AI candidate row to "check". Picks
  // whose pidno IS in the rankings continue to render as a ticked AI
  // candidate, regardless of source — same UX as before.
  const aiPidnos = useMemo(
    () => new Set(rankings.map((r) => r.pidno)),
    [rankings],
  );
  const manualOrphanPicks = useMemo(() => {
    // Find each manual pick's enrichment from the original data.picks —
    // the GET endpoint joins acd_reconstructions for source='manual'
    // rows so proto_code, gloss, set_num and reflex_count come along.
    const byPidno = new Map(data.picks.map((p) => [p.pidno, p]));
    return draftPicks
      .filter((p) => p.source === "manual" && !aiPidnos.has(p.pidno))
      .map((p) => {
        const original = byPidno.get(p.pidno);
        return {
          pidno: p.pidno,
          isPrimary: p.isPrimary,
          protoForm: original?.protoForm ?? `pidno ${p.pidno}`,
          protoCode: original?.protoCode ?? null,
          glossText: original?.glossText ?? null,
          setNum: original?.setNum ?? null,
          reflexCount: original?.reflexCount ?? null,
        };
      });
  }, [draftPicks, aiPidnos, data.picks]);

  return (
    <div className="px-4 py-4 space-y-4">
      {data.spreadsheetProtos && (
        <SpreadsheetReferenceCard data={data.spreadsheetProtos} />
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap">
          <span>{recon.modelId}</span>
          <span>·</span>
          <span>{recon.promptVersion}</span>
          <span>·</span>
          <span>{new Date(recon.computedAt).toLocaleDateString()}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRerun}
          disabled={rerunning}
          className="text-xs text-muted-foreground hover:text-foreground"
          title="Replace these rankings with a fresh AI run. Existing picks stay attached."
        >
          {rerunning ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              re-running…
            </>
          ) : (
            <>
              <Sparkles className="h-3 w-3" />
              re-run with AI
            </>
          )}
        </Button>
      </div>
      {manualOrphanPicks.length > 0 && (
        <section className="space-y-1.5">
          <h4 className="text-xs uppercase tracking-wide font-semibold text-muted-foreground">
            From ACD browse{" "}
            <span className="font-normal opacity-70">
              ({manualOrphanPicks.length})
            </span>
          </h4>
          <ul className="space-y-1.5">
            {manualOrphanPicks.map((p) => (
              <ManualPickRow
                key={p.pidno}
                pidno={p.pidno}
                protoForm={p.protoForm}
                protoCode={p.protoCode}
                glossText={p.glossText}
                setNum={p.setNum}
                reflexCount={p.reflexCount}
                isPrimary={p.isPrimary}
                onRemove={() => onRemoveManualPick(p.pidno)}
                onSetPrimary={() => onSetPrimary(p.pidno)}
              />
            ))}
          </ul>
        </section>
      )}
      <ul className="space-y-2">
        {rankings.map((r) => {
          const pick = pickByPidno.get(r.pidno);
          return (
            <CandidateRow
              key={r.pidno}
              ranking={r}
              checked={pick !== undefined}
              isPrimary={pick?.isPrimary === true}
              onToggle={() => onTogglePick(r.pidno)}
              onSetPrimary={() => onSetPrimary(r.pidno)}
            />
          );
        })}
      </ul>
      <div className="space-y-1.5">
        <Label htmlFor="recon-notes">Notes</Label>
        <textarea
          id="recon-notes"
          value={draftNotes}
          onChange={(e) => onNotesChange(e.target.value)}
          placeholder="(annotator comments)"
          rows={3}
          className="w-full text-sm rounded border border-input bg-background px-3 py-2 font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
      </div>
      {data.entry && (
        <BrowseAcdLink
          entry={{
            id: data.entry.id,
            text: data.entry.text,
            glossRaw: data.entry.glossRaw,
            state: data.entry.state,
          }}
          onBrowseAcd={onBrowseAcd}
        />
      )}
    </div>
  );
}

interface FullReflex {
  language: string;
  form: string;
  gloss_text: string;
  subgroupCode: string;
}

/**
 * A pick from the /dictionary browse path whose pidno isn't in the AI's
 * candidate list. Rendered as its own card paralleling CandidateRow so
 * the annotator sees the same details (proto-code, gloss, reflexes)
 * for a manual pick that they see for an AI pick. Distinguishing
 * details: no rationale, an X remove button, and a slightly different
 * border tint so the source is still recognizable at a glance.
 */
function ManualPickRow({
  pidno,
  protoForm,
  protoCode,
  glossText,
  setNum,
  reflexCount,
  isPrimary,
  onRemove,
  onSetPrimary,
}: {
  pidno: number;
  protoForm: string;
  protoCode: string | null;
  glossText: string | null;
  setNum: number | null;
  reflexCount: number | null;
  isPrimary: boolean;
  onRemove: () => void;
  onSetPrimary: () => void;
}) {
  const [showReflexes, setShowReflexes] = useState(false);
  const [fullReflexes, setFullReflexes] = useState<FullReflex[] | null>(null);
  const [reflexLoading, setReflexLoading] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  function toggleGroup(code: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  async function toggleReflexes() {
    if (showReflexes) {
      setShowReflexes(false);
      return;
    }
    setShowReflexes(true);
    if (fullReflexes === null && !reflexLoading && (reflexCount ?? 0) > 0) {
      setReflexLoading(true);
      try {
        const res = await fetch(`/api/acd/reconstruction/${pidno}`);
        if (res.ok) {
          const body = await res.json();
          setFullReflexes(
            (body.reflexes ?? []).map(
              (r: {
                languageName: string;
                form: string;
                glossText: string;
                subgroupCode?: string;
              }) => ({
                language: r.languageName,
                form: r.form,
                gloss_text: r.glossText,
                subgroupCode: r.subgroupCode ?? "",
              }),
            ),
          );
        }
      } finally {
        setReflexLoading(false);
      }
    }
  }

  const reflexGroups = fullReflexes
    ? groupBySubgroup(fullReflexes)
    : [];

  return (
    <li className="border border-emerald-300 bg-emerald-50/30 rounded p-2.5 transition-colors">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={onSetPrimary}
          aria-label={`mark ${protoForm} as primary`}
          className={cn(
            "mt-0.5 p-0.5 rounded-sm cursor-pointer transition-colors flex-shrink-0",
            isPrimary
              ? "text-amber-500 hover:text-amber-600"
              : "text-stone-300 hover:text-amber-400",
          )}
        >
          <Star className={cn("h-4 w-4", isPrimary && "fill-amber-400")} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono font-medium text-sm">{protoForm}</span>
            {protoCode && (
              <span className="text-[11px] text-muted-foreground">
                {protoCode}
              </span>
            )}
            {setNum !== null && (
              <span className="text-[11px] text-muted-foreground tabular-nums">
                set #{setNum}
              </span>
            )}
            <span className="text-[11px] text-muted-foreground tabular-nums">
              pidno {pidno}
            </span>
          </div>
          {glossText && (
            <p className="mt-0.5 text-[11px] italic text-muted-foreground">
              ‘{glossText}’
            </p>
          )}
          {(reflexCount ?? 0) > 0 && (
            <button
              type="button"
              onClick={toggleReflexes}
              className="mt-1.5 text-xs uppercase tracking-wide text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            >
              {showReflexes ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {showReflexes ? "hide" : "show"} {reflexCount} reflex
              {reflexCount === 1 ? "" : "es"}
            </button>
          )}
          {showReflexes && reflexLoading && (
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              loading reflexes…
            </div>
          )}
          {showReflexes && !reflexLoading && reflexGroups.length > 0 && (
            <div className="mt-2 space-y-2.5">
              {reflexGroups.map((g) => {
                const collapsed = collapsedGroups.has(g.code);
                return (
                  <section key={g.code}>
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.code)}
                      className="w-full flex items-center gap-1 text-xs uppercase tracking-wide font-semibold text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {collapsed ? (
                        <ChevronRight className="h-3 w-3 flex-shrink-0" />
                      ) : (
                        <ChevronDown className="h-3 w-3 flex-shrink-0" />
                      )}
                      <span>{g.label}</span>
                      <span className="tabular-nums font-normal opacity-70">
                        ({g.reflexes.length})
                      </span>
                    </button>
                    {!collapsed && (
                      <ul className="mt-1 space-y-1 pl-4">
                        {g.reflexes.map((r, idx) => (
                          <li
                            key={idx}
                            className="text-xs text-muted-foreground grid gap-2 leading-snug"
                            style={{
                              gridTemplateColumns:
                                "minmax(0, 7rem) minmax(0, 5rem) minmax(0, 1fr)",
                            }}
                          >
                            <span className="break-words">{r.language}</span>
                            <span className="font-mono text-foreground break-words">
                              {r.form}
                            </span>
                            <span className="italic break-words">
                              ‘{r.gloss_text}’
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`remove ${protoForm}`}
          className="mt-0.5 p-0.5 rounded-sm text-muted-foreground hover:text-rose-600 transition-colors flex-shrink-0"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  );
}

function CandidateRow({
  ranking,
  checked,
  isPrimary,
  onToggle,
  onSetPrimary,
}: {
  ranking: Ranking & { totalReflexCount?: number };
  checked: boolean;
  isPrimary: boolean;
  onToggle: () => void;
  onSetPrimary: () => void;
}) {
  const [showReflexes, setShowReflexes] = useState(false);
  // Full reflex list from acd_reflexes (the full ACD corpus), loaded
  // lazily on first expand. Distinct from ranking.sample_reflexes, which
  // is the agent's capped-at-5 sample stored in the rankings JSONB.
  const [fullReflexes, setFullReflexes] = useState<FullReflex[] | null>(null);
  const [reflexLoading, setReflexLoading] = useState(false);
  const totalCount = ranking.totalReflexCount ?? ranking.sample_reflexes.length;
  const confidencePct =
    ranking.confidence === null ? null : Math.round(ranking.confidence * 100);

  async function toggleReflexes() {
    if (showReflexes) {
      setShowReflexes(false);
      return;
    }
    setShowReflexes(true);
    if (fullReflexes === null && !reflexLoading && totalCount > 0) {
      setReflexLoading(true);
      try {
        const res = await fetch(`/api/acd/reconstruction/${ranking.pidno}`);
        if (res.ok) {
          const body = await res.json();
          const reflexes: FullReflex[] = (body.reflexes ?? []).map(
            (r: {
              languageName: string;
              form: string;
              glossText: string;
              subgroupCode?: string;
            }) => ({
              language: r.languageName,
              form: r.form,
              gloss_text: r.glossText,
              subgroupCode: r.subgroupCode ?? "",
            }),
          );
          setFullReflexes(reflexes);
        } else {
          // Fall back to the sample if the corpus endpoint fails (e.g.
          // pidno not in acd_reconstructions — shouldn't happen with the
          // iter-2 import but keep the panel usable either way). The
          // sample doesn't carry subgroupCode; everything groups under
          // "Other" which is acceptable for a degraded fallback.
          setFullReflexes(
            ranking.sample_reflexes.map((r) => ({
              language: r.language,
              form: r.form,
              gloss_text: r.gloss_text,
              subgroupCode: "",
            })),
          );
        }
      } finally {
        setReflexLoading(false);
      }
    }
  }

  const reflexesToRender: FullReflex[] =
    fullReflexes !== null && fullReflexes.length > 0
      ? fullReflexes
      : ranking.sample_reflexes.map((r) => ({
          language: r.language,
          form: r.form,
          gloss_text: r.gloss_text,
          subgroupCode: "",
        }));
  const reflexGroups = groupBySubgroup(reflexesToRender);
  // Per-subgroup collapse state. Sections default to expanded (the
  // empty Set means "nothing collapsed"); the user can fold any branch
  // they're not interested in. State persists across show/hide cycles
  // for this candidate, but resets when a new entry loads (the parent
  // re-renders the candidate list).
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  function toggleGroup(code: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }
  return (
    <li
      className={cn(
        "border rounded p-2.5 transition-colors",
        checked
          ? "border-emerald-300 bg-emerald-50/40"
          : "border-border bg-card",
      )}
    >
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          aria-label={`select ${ranking.proto_form}`}
          className="mt-1.5 h-4 w-4 cursor-pointer accent-emerald-600"
        />
        <button
          type="button"
          onClick={onSetPrimary}
          aria-label={`mark ${ranking.proto_form} as primary`}
          className={cn(
            "mt-0.5 p-0.5 rounded-sm cursor-pointer transition-colors",
            isPrimary
              ? "text-amber-500 hover:text-amber-600"
              : "text-stone-300 hover:text-amber-400",
          )}
        >
          <Star
            className={cn("h-4 w-4", isPrimary && "fill-amber-400")}
          />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
              #{ranking.rank}
            </span>
            <span className="font-mono font-medium text-sm">
              {ranking.proto_form}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {ranking.proto_code}
            </span>
            {confidencePct !== null && (
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {confidencePct}%
              </span>
            )}
            {ranking.is_match && (
              <Badge className="bg-emerald-50 text-emerald-700 border border-emerald-300 font-normal">
                credible
              </Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-foreground/90 leading-snug">
            {ranking.rationale}
          </p>
          {ranking.gloss_text && (
            <p className="mt-0.5 text-[11px] italic text-muted-foreground">
              ‘{ranking.gloss_text}’
            </p>
          )}
          {totalCount > 0 && (
            <button
              type="button"
              onClick={toggleReflexes}
              className="mt-1.5 text-xs uppercase tracking-wide text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            >
              {showReflexes ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {showReflexes ? "hide" : "show"} {totalCount} reflex
              {totalCount === 1 ? "" : "es"}
            </button>
          )}
          {showReflexes && reflexLoading && (
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              loading reflexes…
            </div>
          )}
          {showReflexes && !reflexLoading && (
            <div className="mt-2 space-y-2.5">
              {reflexGroups.map((g) => {
                const collapsed = collapsedGroups.has(g.code);
                return (
                  <section key={g.code}>
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.code)}
                      className="w-full flex items-center gap-1 text-xs uppercase tracking-wide font-semibold text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {collapsed ? (
                        <ChevronRight className="h-3 w-3 flex-shrink-0" />
                      ) : (
                        <ChevronDown className="h-3 w-3 flex-shrink-0" />
                      )}
                      <span>{g.label}</span>
                      <span className="tabular-nums font-normal opacity-70">
                        ({g.reflexes.length})
                      </span>
                    </button>
                    {!collapsed && (
                      <ul className="mt-1 space-y-1 pl-4">
                        {/* Grid with fixed track widths — was a flex row
                            where `w-24 whitespace-nowrap` let long
                            language names overflow visually into the
                            form column. Grid tracks clip the column at
                            the declared width and let the content break
                            instead. */}
                        {g.reflexes.map((r, idx) => (
                          <li
                            key={idx}
                            className="text-xs text-muted-foreground grid gap-2 leading-snug"
                            style={{
                              gridTemplateColumns:
                                "minmax(0, 7rem) minmax(0, 5rem) minmax(0, 1fr)",
                            }}
                          >
                            <span className="break-words">{r.language}</span>
                            <span className="font-mono text-foreground break-words">
                              {r.form}
                            </span>
                            <span className="italic break-words">
                              ‘{r.gloss_text}’
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
