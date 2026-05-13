"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Loader2,
  Plus,
  Star,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/** All present letters in the ACD corpus, in canonical alphabetical order.
 *  Letters absent from the histogram (f, v) are omitted; "?" appears at
 *  the end for orphan entries with no ASCII initial. */
const LETTERS = [
  "a", "b", "c", "d", "e", "g", "h", "i", "j", "k", "l", "m",
  "n", "o", "p", "q", "r", "s", "t", "u", "w", "x", "y", "z",
] as const;

interface AcdRow {
  pidno: number;
  protoCode: string;
  form: string;
  formPlain: string;
  glossText: string;
  setNum: number;
  reflexCount: number;
}

interface LetterResponse {
  letter: string;
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
  rows: AcdRow[];
}

interface AcdReflex {
  id: number;
  languageName: string;
  form: string;
  formPlain: string;
  glossText: string;
  position: number;
}

interface EntryContext {
  id: number;
  text: string;
  glossRaw: string;
}

export default function DictionaryPageWrapper() {
  // useSearchParams suspends during prerender; the Suspense boundary keeps
  // Next.js's static generator from choking on it.
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading dictionary…</div>}>
      <DictionaryPage />
    </Suspense>
  );
}

function DictionaryPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const entryIdParam = searchParams.get("entry_id");
  const letterParam = (searchParams.get("letter") || "a").toLowerCase();
  const pageParam = Number.parseInt(searchParams.get("page") || "1", 10) || 1;

  const entryId = entryIdParam ? Number.parseInt(entryIdParam, 10) : null;
  const letter = LETTERS.includes(letterParam as (typeof LETTERS)[number])
    ? letterParam
    : "a";
  const page = Math.max(1, pageParam);

  const [data, setData] = useState<LetterResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [entryCtx, setEntryCtx] = useState<EntryContext | null>(null);
  const [pickedPidnos, setPickedPidnos] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Fetch the chosen letter's reconstructions.
  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/acd/letter/${letter}?page=${page}&pageSize=50`)
      .then((r) => r.json())
      .then((d: LetterResponse | { error: string }) => {
        if ("error" in d) {
          setError(d.error);
          setData(null);
        } else {
          setData(d);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [letter, page]);

  // Fetch entry context + existing picks so we can show "already picked"
  // chips on rows the annotator has already chosen during prior visits.
  useEffect(() => {
    if (entryId === null) {
      setEntryCtx(null);
      setPickedPidnos(new Set());
      return;
    }
    fetch(`/api/recon/${entryId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d?.entry) {
          setEntryCtx({
            id: d.entry.id,
            text: d.entry.text,
            glossRaw: d.entry.glossRaw,
          });
        }
        const ids = new Set<number>(
          Array.isArray(d?.picks)
            ? d.picks.map((p: { pidno: number }) => p.pidno)
            : [],
        );
        setPickedPidnos(ids);
      })
      .catch(() => {});
  }, [entryId]);

  const goToLetter = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("letter", next);
      params.set("page", "1");
      router.push(`/dictionary?${params.toString()}`);
    },
    [router, searchParams],
  );

  const goToPage = useCallback(
    (next: number) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("page", String(next));
      router.push(`/dictionary?${params.toString()}`);
    },
    [router, searchParams],
  );

  const onPick = useCallback(
    async (pidno: number, isPrimary: boolean) => {
      if (entryId === null) return;
      const res = await fetch(`/api/recon/${entryId}/picks/append`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pidno, isPrimary }),
      });
      if (res.ok) {
        setPickedPidnos((prev) => new Set([...prev, pidno]));
      } else {
        const body = await res.text();
        alert(`Pick failed: ${body}`);
      }
    },
    [entryId],
  );

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Sticky context bar */}
      <header className="border-b border-border bg-card flex-shrink-0">
        <div className="px-6 py-3 flex items-center gap-4">
          <Link
            href={entryId !== null ? `/review?entry_id=${entryId}` : "/review"}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            back to review
          </Link>
          <span className="text-muted-foreground">|</span>
          {entryId !== null && entryCtx ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Annotating:</span>
              <span className="font-mono font-medium">{entryCtx.text}</span>
              <span className="text-muted-foreground italic">
                {entryCtx.glossRaw}
              </span>
            </div>
          ) : entryId !== null ? (
            <span className="text-sm text-muted-foreground">loading entry…</span>
          ) : (
            <span className="text-sm text-muted-foreground">
              Read-only browse. Pass <code>?entry_id=N</code> to enable picking.
            </span>
          )}
        </div>
        {/* Letter tabs */}
        <nav className="px-6 pb-2 flex items-center gap-1 flex-wrap">
          {LETTERS.map((l) => {
            const active = l === letter;
            return (
              <button
                key={l}
                onClick={() => goToLetter(l)}
                className={cn(
                  "px-2 py-1 text-sm font-mono uppercase rounded transition-colors",
                  active
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {l}
              </button>
            );
          })}
        </nav>
      </header>

      {/* Page body */}
      <main className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-6">
          {/* Pagination summary + nav */}
          {data && (
            <div className="flex items-center justify-between mb-4 text-sm text-muted-foreground">
              <span>
                Letter <span className="font-mono uppercase font-semibold text-foreground">{letter}</span> ·{" "}
                {data.totalRows} reconstructions ·{" "}
                page <span className="font-semibold text-foreground">{data.page}</span> of {data.totalPages}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => goToPage(page - 1)}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  prev
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= data.totalPages}
                  onClick={() => goToPage(page + 1)}
                >
                  next
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}

          {loading && (
            <div className="py-12 flex flex-col items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              loading…
            </div>
          )}
          {error && (
            <div className="py-12 text-center text-sm text-rose-700">{error}</div>
          )}

          {data && !loading && data.rows.length === 0 && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No reconstructions for letter <span className="font-mono">{letter}</span>.
            </div>
          )}

          {data && data.rows.length > 0 && (
            <ul className="space-y-3">
              {data.rows.map((r) => (
                <AcdRowItem
                  key={r.pidno}
                  row={r}
                  picked={pickedPidnos.has(r.pidno)}
                  canPick={entryId !== null}
                  onPick={(isPrimary) => onPick(r.pidno, isPrimary)}
                />
              ))}
            </ul>
          )}

          {/* Bottom pagination repeat for long pages */}
          {data && data.rows.length > 10 && (
            <div className="mt-6 flex items-center justify-center gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => goToPage(page - 1)}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                prev
              </Button>
              <span className="px-3 text-sm text-muted-foreground">
                page {data.page} of {data.totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= data.totalPages}
                onClick={() => goToPage(page + 1)}
              >
                next
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function AcdRowItem({
  row,
  picked,
  canPick,
  onPick,
}: {
  row: AcdRow;
  picked: boolean;
  canPick: boolean;
  onPick: (isPrimary: boolean) => void;
}) {
  const [reflexes, setReflexes] = useState<AcdReflex[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [reflexLoading, setReflexLoading] = useState(false);

  async function toggleExpand() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (reflexes === null && !reflexLoading) {
      setReflexLoading(true);
      try {
        const res = await fetch(`/api/acd/reconstruction/${row.pidno}`);
        if (res.ok) {
          const body = await res.json();
          setReflexes(body.reflexes ?? []);
        }
      } finally {
        setReflexLoading(false);
      }
    }
  }

  return (
    <li
      className={cn(
        "border rounded-md transition-colors",
        picked ? "border-emerald-300 bg-emerald-50/50" : "border-border bg-card",
      )}
    >
      <div className="p-4 flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className="font-mono text-lg font-semibold">{row.form}</span>
            <Badge className="bg-stone-50 text-stone-700 border border-stone-300 font-normal">
              {row.protoCode}
            </Badge>
            <span className="text-xs text-muted-foreground tabular-nums">
              set #{row.setNum}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              pidno {row.pidno}
            </span>
          </div>
          <p className="mt-1 text-sm italic text-foreground/90">
            ‘{row.glossText}’
          </p>
          <button
            type="button"
            onClick={toggleExpand}
            className="mt-2 text-[11px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
          >
            {expanded ? "hide" : "show"} {row.reflexCount} reflex
            {row.reflexCount === 1 ? "" : "es"}
          </button>
          {expanded && (
            <div className="mt-2 pl-2 border-l-2 border-border">
              {reflexLoading && (
                <div className="py-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> loading reflexes…
                </div>
              )}
              {reflexes !== null && reflexes.length === 0 && (
                <p className="text-xs italic text-muted-foreground py-1">
                  (no reflexes recorded)
                </p>
              )}
              {reflexes && reflexes.length > 0 && (
                <ul className="space-y-0.5 py-1">
                  {reflexes.map((rx) => (
                    <li
                      key={rx.id}
                      className="text-xs flex gap-2 leading-snug"
                    >
                      <span className="w-32 flex-shrink-0 text-muted-foreground">
                        {rx.languageName}
                      </span>
                      <span className="font-mono flex-shrink-0 text-foreground">
                        {rx.form}
                      </span>
                      <span className="italic text-muted-foreground">
                        ‘{rx.glossText}’
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        {canPick && (
          <div className="flex-shrink-0 flex flex-col gap-1">
            {picked ? (
              <Badge className="bg-emerald-50 text-emerald-700 border border-emerald-300 font-normal whitespace-nowrap">
                <CheckCircle2 className="h-3 w-3 mr-1" />
                picked
              </Badge>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onPick(false)}
                  className="whitespace-nowrap"
                >
                  <Plus className="h-3.5 w-3.5" />
                  add as pick
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onPick(true)}
                  className="whitespace-nowrap text-amber-700 border-amber-300 hover:bg-amber-50"
                  title="Set as the primary pick (clears any other primary)"
                >
                  <Star className="h-3.5 w-3.5" />
                  set primary
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
