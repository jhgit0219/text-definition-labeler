"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  Search,
  Star,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { groupBySubgroup } from "@/lib/recon/subgroups";

interface PrefixHistEntry {
  prefix: string;
  count: number;
}

interface AcdRow {
  pidno: number;
  protoCode: string;
  form: string;
  formPlain: string;
  glossText: string;
  setNum: number;
  reflexCount: number;
}

interface PrefixResponse {
  prefix: string;
  layers: string[];
  totalRows: number;
  protoCodesInPrefix: string[];
  rows: AcdRow[];
}

interface SearchResponse {
  query: string;
  totalRows: number;
  truncated: boolean;
  protoCodesInResults: string[];
  rows: AcdRow[];
}

interface AcdReflex {
  id: number;
  subgroupCode: string;
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
  const prefixParam = (searchParams.get("prefix") || "aa").toLowerCase();
  const layersParam = searchParams.get("layers") || "";

  const entryId = entryIdParam ? Number.parseInt(entryIdParam, 10) : null;
  const layersFilter = useMemo(
    () =>
      new Set(
        layersParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    [layersParam],
  );

  const [prefixHist, setPrefixHist] = useState<PrefixHistEntry[]>([]);
  const [data, setData] = useState<PrefixResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [entryCtx, setEntryCtx] = useState<EntryContext | null>(null);
  const [pickedPidnos, setPickedPidnos] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Default-collapsed prefix nav: usually the user arrives with a
  // specific prefix already targeted (via Browse-ACD link from the
  // recon panel), so showing only that letter's row keeps the header
  // small. Toggle expands to all letters.
  const [navExpanded, setNavExpanded] = useState(false);
  // Search scope: 'prefix' (default) filters the currently-loaded prefix's
  // rows client-side; 'global' fires /api/acd/search across the full
  // corpus. Toggle sits next to the search input.
  const [searchScope, setSearchScope] = useState<"prefix" | "global">(
    "prefix",
  );
  const [globalSearch, setGlobalSearch] = useState<SearchResponse | null>(null);
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false);

  // One-shot fetch of the prefix histogram.
  useEffect(() => {
    fetch(`/api/acd/prefixes`)
      .then((r) => r.json())
      .then((d: { prefixes: PrefixHistEntry[] }) => {
        setPrefixHist(d.prefixes ?? []);
      })
      .catch(() => {});
  }, []);

  // Fetch the chosen prefix's reconstructions whenever prefix or layers
  // filter changes.
  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (layersParam) params.set("layers", layersParam);
    const qs = params.toString();
    fetch(`/api/acd/prefix/${prefixParam}${qs ? `?${qs}` : ""}`)
      .then((r) => r.json())
      .then((d: PrefixResponse | { error: string }) => {
        if ("error" in d) {
          setError(d.error);
          setData(null);
        } else {
          setData(d);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [prefixParam, layersParam]);

  // Global search: when scope is 'global' and the query has >=2 chars,
  // fire the server endpoint with debouncing. Otherwise clear.
  useEffect(() => {
    if (searchScope !== "global") {
      setGlobalSearch(null);
      setGlobalSearchLoading(false);
      return;
    }
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setGlobalSearch(null);
      setGlobalSearchLoading(false);
      return;
    }
    setGlobalSearchLoading(true);
    const handle = setTimeout(() => {
      const params = new URLSearchParams();
      params.set("q", trimmed);
      if (layersParam) params.set("layers", layersParam);
      fetch(`/api/acd/search?${params.toString()}`)
        .then((r) => r.json())
        .then((d: SearchResponse) => setGlobalSearch(d))
        .catch(() => setGlobalSearch(null))
        .finally(() => setGlobalSearchLoading(false));
    }, 250);
    return () => clearTimeout(handle);
  }, [query, searchScope, layersParam]);

  // Fetch entry context + existing picks.
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

  // Group prefix histogram by first letter so the nav can render one row
  // per letter with sub-prefix chips inside.
  const prefixByLetter = useMemo(() => {
    const m = new Map<string, PrefixHistEntry[]>();
    for (const p of prefixHist) {
      const first = p.prefix.charAt(0) || "?";
      if (!m.has(first)) m.set(first, []);
      m.get(first)!.push(p);
    }
    return m;
  }, [prefixHist]);

  const goToPrefix = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("prefix", next);
      router.push(`/dictionary?${params.toString()}`);
    },
    [router, searchParams],
  );

  const toggleLayer = useCallback(
    (layer: string) => {
      const params = new URLSearchParams(searchParams.toString());
      const current = new Set(
        (params.get("layers") || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      if (current.has(layer)) current.delete(layer);
      else current.add(layer);
      if (current.size === 0) params.delete("layers");
      else params.set("layers", Array.from(current).sort().join(","));
      router.push(`/dictionary?${params.toString()}`);
    },
    [router, searchParams],
  );

  const clearLayers = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("layers");
    router.push(`/dictionary?${params.toString()}`);
  }, [router, searchParams]);

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

  // Client-side search (scope=prefix): filter the loaded prefix's rows
  // by case-insensitive substring match against form, form_plain,
  // gloss, or proto_code. When scope=global the rows come from
  // globalSearch state instead.
  const filteredRows = useMemo(() => {
    if (searchScope === "global") {
      return globalSearch?.rows ?? [];
    }
    if (!data) return [];
    const q = query.trim().toLowerCase();
    if (!q) return data.rows;
    return data.rows.filter((r) => {
      return (
        r.form.toLowerCase().includes(q) ||
        r.formPlain.toLowerCase().includes(q) ||
        r.glossText.toLowerCase().includes(q) ||
        r.protoCode.toLowerCase().includes(q)
      );
    });
  }, [data, query, searchScope, globalSearch]);

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

        {/* Search + layer filter row */}
        <div className="px-6 pb-3 flex items-start gap-4 flex-wrap">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                searchScope === "global"
                  ? "search ALL prefixes (form / gloss / proto-code)…"
                  : "search this prefix (form / gloss / proto-code)…"
              }
              className="w-full text-sm rounded border border-input bg-background py-1.5 pl-8 pr-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          {/* Scope toggle — flips between filtering the loaded prefix
              (default) and searching the whole 12K-row ACD corpus. */}
          <div className="inline-flex rounded-md border border-border text-xs overflow-hidden">
            <button
              type="button"
              onClick={() => setSearchScope("prefix")}
              className={cn(
                "px-2.5 py-1 transition-colors",
                searchScope === "prefix"
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              title="Filter the rows currently loaded for the selected prefix"
            >
              in prefix
            </button>
            <button
              type="button"
              onClick={() => setSearchScope("global")}
              className={cn(
                "px-2.5 py-1 transition-colors border-l border-border",
                searchScope === "global"
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              title="Search the entire ACD corpus, ignoring the selected prefix"
            >
              all prefixes
            </button>
          </div>
          {(searchScope === "global"
            ? globalSearch?.protoCodesInResults ?? []
            : data?.protoCodesInPrefix ?? []
          ).length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground mr-1">
                proto layer:
              </span>
              {(searchScope === "global"
                ? globalSearch?.protoCodesInResults ?? []
                : data?.protoCodesInPrefix ?? []
              ).map((code) => {
                const active = layersFilter.has(code);
                return (
                  <button
                    key={code}
                    onClick={() => toggleLayer(code)}
                    className={cn(
                      "px-2 py-0.5 text-[11px] rounded-full border transition-colors font-mono",
                      active
                        ? "bg-foreground text-background border-foreground"
                        : "border-border text-muted-foreground hover:text-foreground hover:border-foreground",
                    )}
                  >
                    {code}
                  </button>
                );
              })}
              {layersFilter.size > 0 && (
                <button
                  onClick={clearLayers}
                  className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 ml-1"
                >
                  <X className="h-3 w-3" />
                  clear
                </button>
              )}
            </div>
          )}
        </div>

        {/* Prefix nav — one row per letter, with 2-letter sub-prefix chips
            inside. Default-collapsed: only the current letter row is shown
            plus a toggle to expand the full list. Each chip has a fixed
            min-width so they grid-align across the row instead of forming
            a ragged wall of variable-width buttons. */}
        <PrefixNav
          prefixByLetter={prefixByLetter}
          activePrefix={prefixParam}
          expanded={navExpanded}
          onToggleExpand={() => setNavExpanded((v) => !v)}
          onPickPrefix={goToPrefix}
        />
      </header>

      {/* Page body — scrollable list, no pagination */}
      <main className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-6">
          {searchScope === "global" ? (
            <div className="mb-4 text-sm text-muted-foreground">
              Global search
              {query.trim() ? (
                <>
                  {" "}
                  for “
                  <span className="text-foreground">{query.trim()}</span>”
                  ·{" "}
                  <span className="text-foreground">
                    {globalSearch?.totalRows ?? 0}
                  </span>{" "}
                  result{(globalSearch?.totalRows ?? 0) === 1 ? "" : "s"}
                  {globalSearch?.truncated && " (truncated; refine query)"}
                </>
              ) : (
                <> — type at least 2 characters to search the full corpus.</>
              )}
              {layersFilter.size > 0 && (
                <>
                  {" "}
                  · filtered by {Array.from(layersFilter).join(", ")}
                </>
              )}
            </div>
          ) : (
            data && (
              <div className="mb-4 text-sm text-muted-foreground">
                Prefix{" "}
                <span className="font-mono uppercase font-semibold text-foreground">
                  {prefixParam}
                </span>{" "}
                · {data.totalRows} reconstructions
                {query.trim() && filteredRows.length !== data.totalRows && (
                  <>
                    {" "}
                    ·{" "}
                    <span className="text-foreground">{filteredRows.length}</span>{" "}
                    match “{query}”
                  </>
                )}
                {layersFilter.size > 0 && (
                  <>
                    {" "}
                    · filtered by {Array.from(layersFilter).join(", ")}
                  </>
                )}
              </div>
            )
          )}

          {(searchScope === "prefix" ? loading : globalSearchLoading) && (
            <div className="py-12 flex flex-col items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              {searchScope === "global" ? "searching corpus…" : "loading…"}
            </div>
          )}
          {error && searchScope === "prefix" && (
            <div className="py-12 text-center text-sm text-rose-700">
              {error}
            </div>
          )}

          {searchScope === "prefix" &&
            data &&
            !loading &&
            data.rows.length === 0 && (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No reconstructions for prefix{" "}
                <span className="font-mono">{prefixParam}</span>
                {layersFilter.size > 0 && " with the chosen layer filter"}.
              </div>
            )}
          {searchScope === "global" &&
            !globalSearchLoading &&
            query.trim().length >= 2 &&
            (globalSearch?.rows.length ?? 0) === 0 && (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No matches for “{query.trim()}” across the full corpus
                {layersFilter.size > 0 && " with the chosen layer filter"}.
              </div>
            )}

          {filteredRows.length > 0 && (
            <ul className="space-y-2">
              {filteredRows.map((r) => (
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
        </div>
      </main>
    </div>
  );
}

function PrefixNav({
  prefixByLetter,
  activePrefix,
  expanded,
  onToggleExpand,
  onPickPrefix,
}: {
  prefixByLetter: Map<string, PrefixHistEntry[]>;
  activePrefix: string;
  expanded: boolean;
  onToggleExpand: () => void;
  onPickPrefix: (prefix: string) => void;
}) {
  const allLetters = useMemo(
    () => Array.from(prefixByLetter.keys()).sort(),
    [prefixByLetter],
  );
  const activeLetter = (activePrefix || "").charAt(0);
  // When collapsed we show only the row matching the active prefix's
  // first letter. If the active letter isn't in the corpus (rare),
  // fall back to the first letter that is.
  const visibleLetters = expanded
    ? allLetters
    : allLetters.filter(
        (l) => l === activeLetter || (!allLetters.includes(activeLetter) && l === allLetters[0]),
      );

  return (
    <div className="px-6 pb-3">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {expanded ? "All prefixes" : `Letter ${activeLetter.toUpperCase() || "—"}`}
        </span>
        <button
          type="button"
          onClick={onToggleExpand}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? (
            <>
              <ChevronDown className="h-3.5 w-3.5" />
              hide all letters
            </>
          ) : (
            <>
              <ChevronRight className="h-3.5 w-3.5" />
              show all letters
            </>
          )}
        </button>
      </div>
      <nav
        className={cn(
          "space-y-1.5",
          expanded && "max-h-[40vh] overflow-y-auto pr-1",
        )}
      >
        {visibleLetters.map((letter) => {
          const chips = prefixByLetter.get(letter) ?? [];
          return (
            <div key={letter} className="flex items-center gap-3">
              <span className="font-mono uppercase text-sm font-bold text-foreground w-6 flex-shrink-0 text-center">
                {letter}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {chips.map((c) => {
                  const active = c.prefix === activePrefix;
                  return (
                    <button
                      key={c.prefix}
                      onClick={() => onPickPrefix(c.prefix)}
                      className={cn(
                        "inline-flex items-baseline justify-center gap-1.5",
                        "min-w-[3.75rem] px-2.5 py-1",
                        "text-sm font-mono rounded-md border transition-colors",
                        active
                          ? "bg-foreground text-background border-foreground"
                          : "border-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground",
                      )}
                      title={`${c.count} reconstructions starting with ${c.prefix}`}
                    >
                      <span className="font-medium">{c.prefix}</span>
                      <span
                        className={cn(
                          "text-[10px] tabular-nums",
                          active
                            ? "text-background/60"
                            : "text-muted-foreground/60",
                        )}
                      >
                        {c.count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>
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

  // Per-subgroup collapse state. Defaults to "nothing collapsed" so
  // the first time the user expands the card every branch is visible.
  // State persists across show/hide cycles within this row's lifetime.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  function toggleGroup(code: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

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
        picked ? "border-emerald-300 bg-emerald-50/40" : "border-border bg-card",
      )}
    >
      <div className="p-3 flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2.5 flex-wrap">
            <span className="font-mono text-base font-semibold">{row.form}</span>
            <Badge className="bg-stone-50 text-stone-700 border border-stone-300 font-normal">
              {row.protoCode}
            </Badge>
            <span className="text-[11px] text-muted-foreground tabular-nums">
              set #{row.setNum}
            </span>
            <span className="text-[11px] text-muted-foreground tabular-nums">
              pidno {row.pidno}
            </span>
          </div>
          <p className="mt-0.5 text-sm italic text-foreground/90 leading-snug">
            ‘{row.glossText}’
          </p>
          <button
            type="button"
            onClick={toggleExpand}
            className="mt-1.5 text-xs uppercase tracking-wide text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            {expanded ? "hide" : "show"}{" "}
            <span className="tabular-nums">{row.reflexCount}</span>{" "}
            reflex{row.reflexCount === 1 ? "" : "es"}
          </button>
          {expanded && (
            <div className="mt-2 pl-3 border-l-2 border-border">
              {reflexLoading && (
                <div className="py-1 flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> loading reflexes…
                </div>
              )}
              {reflexes !== null && reflexes.length === 0 && (
                <p className="text-sm italic text-muted-foreground py-1">
                  (no reflexes recorded)
                </p>
              )}
              {reflexes && reflexes.length > 0 && (
                <div className="mt-1 space-y-3">
                  {groupBySubgroup(reflexes).map((group) => {
                    const collapsed = collapsedGroups.has(group.code);
                    return (
                      <section key={group.code}>
                        <button
                          type="button"
                          onClick={() => toggleGroup(group.code)}
                          className="w-full flex items-center gap-1 text-xs uppercase tracking-wide font-semibold text-muted-foreground hover:text-foreground transition-colors mb-1"
                        >
                          {collapsed ? (
                            <ChevronRight className="h-3 w-3 flex-shrink-0" />
                          ) : (
                            <ChevronDown className="h-3 w-3 flex-shrink-0" />
                          )}
                          <span>{group.label}</span>
                          <span className="tabular-nums font-normal opacity-70">
                            ({group.reflexes.length})
                          </span>
                        </button>
                        {!collapsed && (
                          <table className="text-sm w-full table-fixed">
                            {/* table-fixed + colgroup makes the column
                                widths authoritative; without them, long
                                language names like "Proto-South Sulawesi"
                                expanded their cell past the declared
                                width and overlapped the form column. */}
                            <colgroup>
                              <col className="w-48" />
                              <col className="w-32" />
                              <col />
                            </colgroup>
                            <tbody>
                              {group.reflexes.map((rx) => (
                                <tr
                                  key={rx.id}
                                  className="align-top leading-snug"
                                >
                                  <td className="pr-4 text-muted-foreground py-1 break-words">
                                    {rx.languageName}
                                  </td>
                                  <td className="pr-4 font-mono text-foreground py-1 break-words">
                                    {rx.form}
                                  </td>
                                  <td className="italic text-muted-foreground py-1 break-words">
                                    ‘{rx.glossText}’
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </section>
                    );
                  })}
                </div>
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
