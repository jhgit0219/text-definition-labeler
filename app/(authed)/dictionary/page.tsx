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
  Loader2,
  Plus,
  Search,
  Star,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

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

  // Client-side search: filter the loaded rows by case-insensitive
  // substring match against form, form_plain, gloss, or proto_code.
  const filteredRows = useMemo(() => {
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
  }, [data, query]);

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
              placeholder="search this prefix (form / gloss / proto-code)…"
              className="w-full text-sm rounded border border-input bg-background py-1.5 pl-8 pr-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          {data && data.protoCodesInPrefix.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground mr-1">
                proto layer:
              </span>
              {data.protoCodesInPrefix.map((code) => {
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

        {/* Prefix nav — grouped by letter, 2-letter sub-prefixes as chips */}
        <nav className="px-6 pb-3 space-y-1">
          {Array.from(prefixByLetter.keys())
            .sort()
            .map((letter) => {
              const chips = prefixByLetter.get(letter) ?? [];
              return (
                <div
                  key={letter}
                  className="flex items-baseline gap-2 leading-tight"
                >
                  <span className="font-mono uppercase text-xs text-muted-foreground w-4 flex-shrink-0">
                    {letter}
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {chips.map((c) => {
                      const active = c.prefix === prefixParam;
                      return (
                        <button
                          key={c.prefix}
                          onClick={() => goToPrefix(c.prefix)}
                          className={cn(
                            "px-1.5 py-0.5 text-xs font-mono rounded transition-colors inline-flex items-baseline gap-1",
                            active
                              ? "bg-foreground text-background"
                              : "text-muted-foreground hover:bg-muted hover:text-foreground",
                          )}
                          title={`${c.count} reconstructions`}
                        >
                          <span>{c.prefix}</span>
                          <span
                            className={cn(
                              "text-[10px] tabular-nums",
                              active
                                ? "text-background/70"
                                : "text-muted-foreground/70",
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
      </header>

      {/* Page body — scrollable list, no pagination */}
      <main className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-6">
          {data && (
            <div className="mb-4 text-sm text-muted-foreground">
              Prefix{" "}
              <span className="font-mono uppercase font-semibold text-foreground">
                {prefixParam}
              </span>{" "}
              · {data.totalRows} reconstructions
              {query.trim() && filteredRows.length !== data.totalRows && (
                <>
                  {" "}
                  · <span className="text-foreground">{filteredRows.length}</span>{" "}
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
          )}

          {loading && (
            <div className="py-12 flex flex-col items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              loading…
            </div>
          )}
          {error && (
            <div className="py-12 text-center text-sm text-rose-700">
              {error}
            </div>
          )}

          {data && !loading && data.rows.length === 0 && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No reconstructions for prefix{" "}
              <span className="font-mono">{prefixParam}</span>
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
            className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
          >
            {expanded ? "hide" : "show"}{" "}
            <span className="tabular-nums">{row.reflexCount}</span>{" "}
            reflex{row.reflexCount === 1 ? "" : "es"}
          </button>
          {expanded && (
            <div className="mt-1.5 pl-3 border-l-2 border-border">
              {reflexLoading && (
                <div className="py-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> loading reflexes…
                </div>
              )}
              {reflexes !== null && reflexes.length === 0 && (
                <p className="text-xs italic text-muted-foreground py-1">
                  (no reflexes recorded)
                </p>
              )}
              {reflexes && reflexes.length > 0 && (
                <table className="text-xs w-full mt-1">
                  <tbody>
                    {reflexes.map((rx) => (
                      <tr key={rx.id} className="align-top leading-snug">
                        <td className="w-32 pr-3 text-muted-foreground whitespace-nowrap">
                          {rx.languageName}
                        </td>
                        <td className="w-28 pr-3 font-mono text-foreground whitespace-nowrap">
                          {rx.form}
                        </td>
                        <td className="italic text-muted-foreground">
                          ‘{rx.glossText}’
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
