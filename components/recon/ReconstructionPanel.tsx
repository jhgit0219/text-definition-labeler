"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  ExternalLink,
  Sparkles,
  Star,
  Trash2,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { groupBySubgroup } from "@/lib/recon/subgroups";
import {
  fetchReconstruction,
  enqueueReconstruction,
  cancelQueuedJob,
  clearReconstruction,
  fetchActiveJob,
  savePicks,
  ReconError,
  type ActiveJobDto,
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
  | { kind: "miss"; entry: Entry; data: ReconResponseDto }
  | { kind: "queued"; entry: Entry; job: ActiveJobDto; spreadsheet: SpreadsheetProtosDto | null }
  // Worker pre-flight health check failed with 503 worker_offline. The
  // Render free tier spins down after 15min idle and takes 30–60s to
  // wake; one 3.5s health probe can't see through that. We retry from
  // the client every WARMING_INTERVAL_MS until either the worker
  // responds or we exhaust attempts.
  | {
      kind: "warming";
      entry: Entry;
      attempt: number;
      force: boolean;
      previous: PanelState;
    }
  | { kind: "done"; entry: Entry; data: ReconResponseDto }
  | { kind: "error"; entry: Entry; message: string; previous: PanelState | null };

const MAX_WARMING_ATTEMPTS = 4;
const WARMING_INTERVAL_MS = 15_000;

export function ReconstructionPanel({
  entry,
  onBrowseAcd,
  reloadKey,
}: Props) {
  const [state, setState] = useState<PanelState>({ kind: "no-entry" });
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [internalReload, setInternalReload] = useState(0);

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
  // Job IDs we've already auto-opened the auth tab for. Without this we'd
  // pop a new tab every 3s on every poll.
  const authOpenedRef = useRef<Set<number>>(new Set());

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
        if (data.activeJob && data.activeJob.status !== "done") {
          setState({
            kind: "queued",
            entry,
            job: data.activeJob,
            spreadsheet: data.spreadsheetProtos,
          });
          setDraftPicks([]);
          setDraftNotes(data.entryNotes ?? "");
          setSavedSnapshot({ picks: [], notes: data.entryNotes ?? "" });
          return;
        }
        if (data.reconstruction === null) {
          const initialPicks: PickInput[] = data.picks.map((p) => ({
            pidno: p.pidno,
            isPrimary: p.isPrimary,
            source: p.source,
          }));
          setState({ kind: "miss", entry, data });
          setDraftPicks(initialPicks);
          setDraftNotes(data.entryNotes ?? "");
          setSavedSnapshot({ picks: initialPicks, notes: data.entryNotes ?? "" });
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
          previous: null,
        });
      });
  }, [entry?.id, entry?.state, reloadKey, internalReload]);

  // Poll the job endpoint while we're in the queued state. Transitions:
  //   pending/running -> done  : refetch GET /api/recon, switch to "done"
  //   pending/running -> error : surface error and let the user retry
  useEffect(() => {
    if (state.kind !== "queued") return;
    const entryId = state.entry.id;
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const job = await fetchActiveJob(entryId);
        if (cancelled || activeEntryRef.current !== entryId) return;
        if (!job) return;
        if (job.status === "done") {
          const data = await fetchReconstruction(entryId);
          if (cancelled || activeEntryRef.current !== entryId) return;
          const initialPicks: PickInput[] = data.picks.map((p) => ({
            pidno: p.pidno,
            isPrimary: p.isPrimary,
            source: p.source,
          }));
          setDraftPicks(initialPicks);
          setDraftNotes(data.entryNotes ?? "");
          setSavedSnapshot({ picks: initialPicks, notes: data.entryNotes ?? "" });
          setState({ kind: "done", entry: state.entry, data });
          return;
        }
        if (job.status === "error") {
          setState({
            kind: "error",
            entry: state.entry,
            message: job.errorMessage ?? "Reconstruction failed",
            previous: null,
          });
          return;
        }
        // If the worker is parked waiting on Gemini OAuth, auto-open the
        // worker's /auth page in a new tab (once per job) so the
        // researcher doesn't have to dig through error_message manually.
        if (job.errorKind === "auth_required" && job.errorMessage) {
          const urlMatch = job.errorMessage.match(/https?:\/\/\S+/);
          if (urlMatch && !authOpenedRef.current.has(job.id)) {
            authOpenedRef.current.add(job.id);
            window.open(urlMatch[0], "_blank", "noopener,noreferrer");
          }
        }
        // still pending / running — update job in state so position / timer refresh
        setState((prev) =>
          prev.kind === "queued" ? { ...prev, job } : prev,
        );
      } catch {
        // ignore transient polling failures
      }
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [state.kind === "queued" ? state.entry.id : null]);

  // Warming retry loop. Re-runs whenever attempt count bumps. When the
  // worker eventually responds, the enqueue succeeds and we flip to
  // "queued". When attempts run out we surface an error with the
  // previous miss/done state attached so the user can bail back.
  useEffect(() => {
    if (state.kind !== "warming") return;
    const { entry: warmEntry, attempt, force, previous } = state;

    if (attempt > MAX_WARMING_ATTEMPTS) {
      setState({
        kind: "error",
        entry: warmEntry,
        message:
          "The reconstruction worker didn't wake up after ~60 seconds. " +
          "It may be down or mid-deploy — wait a moment, then retry.",
        previous,
      });
      return;
    }

    const timeout = setTimeout(async () => {
      if (activeEntryRef.current !== warmEntry.id) return;
      try {
        await enqueueReconstruction(warmEntry.id, { force });
        if (activeEntryRef.current !== warmEntry.id) return;
        const job = await fetchActiveJob(warmEntry.id);
        if (activeEntryRef.current !== warmEntry.id) return;
        if (job) {
          const spreadsheet =
            previous.kind === "miss" || previous.kind === "done"
              ? previous.data.spreadsheetProtos
              : null;
          setState({ kind: "queued", entry: warmEntry, job, spreadsheet });
        }
      } catch (err) {
        if (activeEntryRef.current !== warmEntry.id) return;
        if (isWorkerOfflineError(err)) {
          setState((prev) =>
            prev.kind === "warming"
              ? { ...prev, attempt: prev.attempt + 1 }
              : prev,
          );
        } else {
          setState({
            kind: "error",
            entry: warmEntry,
            message: err instanceof Error ? err.message : String(err),
            previous,
          });
        }
      }
    }, WARMING_INTERVAL_MS);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.kind === "warming" ? state.attempt : 0,
    state.kind === "warming" ? state.entry.id : null,
  ]);

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
    const previousState = state;
    const targetEntry = state.entry;
    const spreadsheet = state.data.spreadsheetProtos;
    setRunning(true);
    try {
      await enqueueReconstruction(targetEntry.id, opts);
      if (activeEntryRef.current !== targetEntry.id) return;
      const job = await fetchActiveJob(targetEntry.id);
      if (activeEntryRef.current !== targetEntry.id) return;
      if (job) {
        setState({ kind: "queued", entry: targetEntry, job, spreadsheet });
      }
    } catch (err) {
      if (activeEntryRef.current !== targetEntry.id) return;
      // 503 worker_offline = pre-flight health check timed out. Most
      // common cause is Render cold-start; the first probe always misses
      // it because the container takes 30–60s to boot. Flip to warming
      // so the retry effect can keep trying.
      if (isWorkerOfflineError(err)) {
        setState({
          kind: "warming",
          entry: targetEntry,
          attempt: 1,
          force: opts.force === true,
          previous: previousState,
        });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setState({
          kind: "error",
          entry: targetEntry,
          message: msg,
          previous: previousState,
        });
      }
    } finally {
      setRunning(false);
    }
  }

  async function onSave() {
    if (state.kind !== "done" && state.kind !== "miss") return;
    const previousState = state;
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
      setState({
        kind: "error",
        entry: state.entry,
        message: msg,
        previous: previousState,
      });
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
            data={state.data}
            draftPicks={draftPicks}
            onSetPrimary={setPrimary}
            onRemoveManualPick={removeManualPick}
            onAttempt={() => onAttempt()}
            running={running}
            onBrowseAcd={onBrowseAcd}
            draftNotes={draftNotes}
            onNotesChange={setDraftNotes}
          />
        )}
        {state.kind === "warming" && (
          <WarmingView
            attempt={state.attempt}
            maxAttempts={MAX_WARMING_ATTEMPTS}
            onCancel={() => {
              const previous = state.previous;
              setState(previous);
            }}
          />
        )}
        {state.kind === "queued" && (
          <QueuedView
            entry={state.entry}
            job={state.job}
            spreadsheet={state.spreadsheet}
            onBrowseAcd={onBrowseAcd}
            onCancel={async () => {
              try {
                await cancelQueuedJob(state.entry.id);
                setInternalReload((k) => k + 1);
              } catch (err) {
                setState({
                  kind: "error",
                  entry: state.entry,
                  message: err instanceof Error ? err.message : String(err),
                  previous: null,
                });
              }
            }}
          />
        )}
        {state.kind === "error" && (
          <ErrorView
            message={state.message}
            onBack={
              state.previous
                ? (() => {
                    const previous = state.previous;
                    return () => setState(previous);
                  })()
                : undefined
            }
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
                    setState({ kind: "miss", entry: state.entry, data });
                  }
                })
                .catch((err) => {
                  setState({
                    kind: "error",
                    entry: state.entry,
                    message: err instanceof Error ? err.message : String(err),
                    previous: null,
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
            onClear={async () => {
              if (
                !window.confirm(
                  "Clear the AI rankings for this word? Your picks stay attached, but the panel will show as cache-miss until you click Attempt with AI again.",
                )
              ) {
                return;
              }
              try {
                await clearReconstruction(state.entry.id);
                setInternalReload((k) => k + 1);
              } catch (err) {
                setState({
                  kind: "error",
                  entry: state.entry,
                  message: err instanceof Error ? err.message : String(err),
                  previous: state,
                });
              }
            }}
          />
        )}
      </div>

      {(state.kind === "done" || state.kind === "miss") && (
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

// Recognise the worker_offline 503 payload thrown by /api/recon POST.
// Anything else (404, 500, 409, network error) is a real failure and
// should surface as an error state — not a cold-start retry.
function isWorkerOfflineError(err: unknown): boolean {
  if (!(err instanceof ReconError)) return false;
  if (err.status !== 503) return false;
  const body = err.body;
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { code?: unknown }).code === "worker_offline"
  );
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
  onBack,
}: {
  message: string;
  onRetry: () => void;
  /** When set, render a "Back to entry" button that restores the
   *  previous panel state (the one we were in right before the failed
   *  action). Lets the annotator bail out of an error without re-firing
   *  the request — useful when the AI service is down and they want to
   *  fall back to Browse-ACD instead. */
  onBack?: () => void;
}) {
  return (
    <div className="px-6 py-12 flex flex-col items-center gap-3 text-sm">
      <AlertCircle className="h-5 w-5 text-rose-600" />
      <p className="text-center text-muted-foreground">{message}</p>
      <div className="flex items-center gap-2">
        {onBack && (
          <Button onClick={onBack} variant="ghost" size="sm">
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to entry
          </Button>
        )}
        <Button onClick={onRetry} variant="outline" size="sm">
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </Button>
      </div>
    </div>
  );
}

function WarmingView({
  attempt,
  maxAttempts,
  onCancel,
}: {
  attempt: number;
  maxAttempts: number;
  onCancel: () => void;
}) {
  return (
    <div className="px-4 py-4">
      <div className="rounded-md border border-amber-200 bg-amber-50/60 p-4 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-amber-700" />
            <span className="text-sm font-semibold text-amber-900">
              Waking the worker… ({attempt}/{maxAttempts})
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            className="text-xs text-amber-900/70 hover:text-destructive"
            title="Stop retrying and go back to the entry."
          >
            <X className="h-3 w-3" />
            cancel
          </Button>
        </div>
        <p className="text-xs text-amber-900/80 leading-snug">
          The worker is on Render&apos;s free tier — it spins down after
          15 min idle and takes 30–60s to wake. We&apos;ll keep retrying
          every 15s. Your job hasn&apos;t been enqueued yet; once the
          worker responds, we&apos;ll add it to the queue automatically.
        </p>
      </div>
    </div>
  );
}

function QueuedView({
  entry,
  job,
  spreadsheet,
  onBrowseAcd,
  onCancel,
}: {
  entry: Entry;
  job: ActiveJobDto;
  spreadsheet: SpreadsheetProtosDto | null;
  onBrowseAcd?: (prefix: string) => void;
  onCancel: () => void;
}) {
  const elapsedSec = job.startedAt
    ? Math.max(0, Math.floor((Date.now() - new Date(job.startedAt).getTime()) / 1000))
    : 0;
  const authRequired = job.errorKind === "auth_required";
  const authUrl = authRequired
    ? job.errorMessage?.match(/https?:\/\/\S+/)?.[0] ?? null
    : null;
  return (
    <div className="px-4 py-4 space-y-4">
      {spreadsheet && <SpreadsheetReferenceCard data={spreadsheet} />}
      {authRequired && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 space-y-2">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-amber-700 flex-shrink-0" />
            <span className="text-sm font-semibold text-amber-900">
              Gemini auth needed
            </span>
          </div>
          <p className="text-xs text-amber-900/80 leading-snug">
            The worker can&apos;t reach Gemini until someone completes the
            OAuth flow. We&apos;ve opened a tab to the auth page — sign in
            with the team&apos;s Gemini account there and paste the code
            Google gives you. Your job will resume automatically.
          </p>
          {authUrl && (
            <a
              href={authUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-900 underline hover:text-amber-700"
            >
              <ExternalLink className="h-3 w-3" />
              Open auth page
            </a>
          )}
        </div>
      )}
      <div className="rounded-md border border-blue-200 bg-blue-50/60 p-4 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-blue-700" />
            <span className="text-sm font-semibold text-blue-900">
              {job.status === "running"
                ? `Reconstructing… (${elapsedSec}s)`
                : "Queued"}
            </span>
          </div>
          {job.status === "pending" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onCancel}
              className="text-xs text-blue-900/70 hover:text-destructive"
              title="Remove this job from the queue before the worker claims it."
            >
              <X className="h-3 w-3" />
              cancel
            </Button>
          )}
        </div>
        <p className="text-xs text-blue-900/80 leading-snug">
          {job.status === "running" ? (
            <>The worker is calling the AI service. This usually takes 1–5 minutes. Can't cancel mid-run — clear the result afterward if you don't want it.</>
          ) : job.position !== null ? (
            <>
              Position <span className="font-semibold">{job.position}</span> in
              the queue. You can leave this page — we'll save the result when
              it lands.
            </>
          ) : (
            <>Waiting for the worker to pick this up…</>
          )}
        </p>
      </div>
      <BrowseAcdLink entry={entry} onBrowseAcd={onBrowseAcd} />
    </div>
  );
}

function MissView({
  entry,
  data,
  draftPicks,
  draftNotes,
  onSetPrimary,
  onRemoveManualPick,
  onNotesChange,
  onAttempt,
  running,
  onBrowseAcd,
}: {
  entry: Entry;
  data: ReconResponseDto;
  draftPicks: PickInput[];
  draftNotes: string;
  onSetPrimary: (pidno: number) => void;
  onRemoveManualPick: (pidno: number) => void;
  onNotesChange: (s: string) => void;
  onAttempt: () => void;
  running: boolean;
  onBrowseAcd?: (prefix: string) => void;
}) {
  const manualPicks = useMemo(() => {
    const byPidno = new Map(data.picks.map((p) => [p.pidno, p]));
    return draftPicks
      .filter((p) => p.source === "manual")
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
  }, [draftPicks, data.picks]);

  return (
    <div className="px-4 py-4 space-y-4">
      {data.spreadsheetProtos && (
        <SpreadsheetReferenceCard data={data.spreadsheetProtos} />
      )}
      <div className="border border-dashed border-border rounded p-4 text-center space-y-3">
        <p className="text-sm text-muted-foreground">
          No AI reconstruction yet for{" "}
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
      {manualPicks.length > 0 && (
        <section className="space-y-1.5">
          <h4 className="text-xs uppercase tracking-wide font-semibold text-muted-foreground">
            Manual picks{" "}
            <span className="font-normal opacity-70">
              ({manualPicks.length})
            </span>
          </h4>
          <ul className="space-y-1.5">
            {manualPicks.map((p) => (
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
      <BrowseAcdLink entry={entry} onBrowseAcd={onBrowseAcd} />
      <div className="space-y-1.5">
        <Label htmlFor="miss-notes">Notes</Label>
        <textarea
          id="miss-notes"
          value={draftNotes}
          onChange={(e) => onNotesChange(e.target.value)}
          placeholder="(annotator comments)"
          rows={3}
          className="w-full text-sm rounded border border-input bg-background px-3 py-2 font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
      </div>
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
  onClear,
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
  onClear: () => void;
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

  const preAcceptState =
    recon.computedAgainstState &&
    recon.computedAgainstState !== "accepted"
      ? recon.computedAgainstState
      : null;

  return (
    <div className="px-4 py-4 space-y-4">
      {data.spreadsheetProtos && (
        <SpreadsheetReferenceCard data={data.spreadsheetProtos} />
      )}
      {preAcceptState && (
        <div className="rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-left">
          <p className="text-[11px] text-amber-900 leading-snug">
            <span className="font-semibold">Pre-acceptance ranking.</span>{" "}
            This reconstruction was generated when the entry was{" "}
            <span className="font-mono">{preAcceptState}</span>. The text /
            gloss may have changed since — confirm before committing picks.
          </p>
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap">
          <span>{recon.modelId}</span>
          <span>·</span>
          <span>{recon.promptVersion}</span>
          <span>·</span>
          <span>{new Date(recon.computedAt).toLocaleDateString()}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            className="text-xs text-muted-foreground hover:text-destructive"
            title="Delete these AI rankings. Picks stay attached; the panel returns to cache-miss."
          >
            <Trash2 className="h-3 w-3" />
            clear
          </Button>
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
      </div>
      {recon.agentMeta?.summary && (
        <div className="rounded-md border border-sky-200 bg-sky-50/60 px-3 py-2">
          <div className="flex items-start gap-2">
            <Sparkles className="h-3.5 w-3.5 text-sky-700 mt-0.5 flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wide font-semibold text-sky-900 mb-0.5">
                AI summary
              </p>
              <p className="text-xs text-sky-900/90 leading-snug">
                {recon.agentMeta.summary}
              </p>
            </div>
          </div>
        </div>
      )}
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
