"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  LogOut,
  Plus,
  X,
  Download,
  FileSpreadsheet,
  Wand2,
  ZoomIn,
  ZoomOut,
  Maximize2,
} from "lucide-react";
import {
  TransformWrapper,
  TransformComponent,
  type ReactZoomPanPinchRef,
} from "react-zoom-pan-pinch";
import { useRef } from "react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ReconstructionPanel } from "@/components/recon/ReconstructionPanel";
import { DictionaryView } from "@/components/dictionary/DictionaryView";

type EntryState = "pending" | "accepted" | "rejected" | "no_ouv";

type Entry = {
  id: number;
  page: number;
  entryIdx: number;
  text: string;
  glossRaw: string;
  glosses: string[];
  state: EntryState;
  edited: boolean;
  isMultiRegion: boolean;
  predTextRaw: string | null;
  predGlossRaw: string | null;
  snappedFrom: string | null;
};

type PageRow = {
  page: number;
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
  no_ouv: number;
};

type Tab = "all" | "pending" | "accepted" | "rejected" | "no_ouv";

function hasOUV(s: string): boolean {
  const t = (s || "").toLowerCase();
  return ["u", "o", "v", "ú", "ó"].some((c) => t.includes(c));
}

function joinGlosses(glosses: string[]): string {
  const cleaned = glosses
    .map((g) => g.trim().replace(/\.+$/, ""))
    .filter(Boolean);
  if (cleaned.length === 0) return "";
  return cleaned.map((g) => g + ".").join(" ");
}

const STATE_LABELS: Record<EntryState, string> = {
  pending: "pending",
  accepted: "accepted",
  rejected: "rejected",
  no_ouv: "no OUV",
};

// Tailwind class map for the state badges. Soft pastel fill + matching outline
// per state so each pill carries a recognizable color silhouette.
const STATE_BADGE_CLASS: Record<EntryState, string> = {
  pending: "bg-stone-50 text-stone-700 border border-stone-300",
  accepted: "bg-emerald-50 text-emerald-700 border border-emerald-300",
  rejected: "bg-rose-50 text-rose-700 border border-rose-300",
  no_ouv: "bg-amber-50 text-amber-700 border border-amber-300",
};

export default function ReviewPageWrapper() {
  // useSearchParams needs a Suspense boundary for Next.js static gen
  // and for the page to survive prerender.
  return (
    <Suspense fallback={null}>
      <ReviewPage />
    </Suspense>
  );
}

function ReviewPage() {
  const searchParams = useSearchParams();
  const requestedEntryIdRaw = searchParams.get("entry_id");
  const requestedEntryId = useMemo(() => {
    if (!requestedEntryIdRaw) return null;
    const n = Number.parseInt(requestedEntryIdRaw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [requestedEntryIdRaw]);

  const [pages, setPages] = useState<PageRow[]>([]);
  const [currentPage, setCurrentPage] = useState<number | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [draftText, setDraftText] = useState("");
  const [draftGlosses, setDraftGlosses] = useState<string[]>([]);
  // Pending request to focus a specific entry once its page is loaded.
  // Set when ?entry_id=N is in the URL — the load sequence is two-step
  // (lookup entry -> set currentPage -> wait for entries -> setActiveId).
  const [pendingFocusId, setPendingFocusId] = useState<number | null>(null);
  // ACD-browse drawer state. When `dictionaryDrawer` is non-null, the
  // DictionaryView mounts as a full-height overlay on top of the
  // review layout. Bumping reconReloadKey forces the recon panel to
  // refetch picks/data after a pick lands inside the drawer.
  const [dictionaryDrawer, setDictionaryDrawer] = useState<
    { entryId: number; prefix: string } | null
  >(null);
  const [reconReloadKey, setReconReloadKey] = useState(0);
  // Imperative handle on the zoom-pan wrapper so toolbar buttons can drive it.
  const zoomRef = useRef<ReactZoomPanPinchRef | null>(null);

  // If the URL carries entry_id, look up that entry to find its page,
  // then switch to that page and remember to focus the entry once
  // entries finish loading. Runs once per URL change.
  useEffect(() => {
    if (requestedEntryId === null) return;
    let cancelled = false;
    fetch(`/api/recon/${requestedEntryId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d?.entry) return;
        setPendingFocusId(d.entry.id);
        setCurrentPage(d.entry.page);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [requestedEntryId]);

  useEffect(() => {
    fetch("/api/pages")
      .then((r) => r.json())
      .then((d) => {
        setPages(d.pages || []);
        if (
          d.pages?.length &&
          currentPage === null &&
          requestedEntryId === null
        ) {
          setCurrentPage(d.pages[0].page);
        }
      });
  }, [requestedEntryId]);

  useEffect(() => {
    if (currentPage === null) return;
    fetch(`/api/entries?page=${currentPage}`)
      .then((r) => r.json())
      .then((d) => {
        setEntries(d.entries || []);
        // If a pending focus is queued and the entry exists on this
        // page, select it. Otherwise reset selection as before.
        if (pendingFocusId !== null) {
          const found = (d.entries || []).some(
            (e: Entry) => e.id === pendingFocusId,
          );
          if (found) {
            setActiveId(pendingFocusId);
          } else {
            setActiveId(null);
          }
          setPendingFocusId(null);
        } else {
          setActiveId(null);
        }
      });
  }, [currentPage]);

  const active = useMemo(
    () => entries.find((e) => e.id === activeId) ?? null,
    [entries, activeId],
  );

  useEffect(() => {
    if (active) {
      setDraftText(active.text);
      const arr =
        active.glosses.length > 0
          ? [...active.glosses]
          : active.glossRaw
              .split(/\.\s*|\s*\.\s*$/)
              .map((p) => p.trim())
              .filter(Boolean);
      setDraftGlosses(arr);
    }
  }, [active]);

  const filtered = useMemo(() => {
    if (tab === "all") return entries;
    return entries.filter((e) => e.state === tab);
  }, [entries, tab]);

  const counts = useMemo(() => {
    const c = { pending: 0, accepted: 0, rejected: 0, no_ouv: 0 };
    for (const e of entries) {
      (c as Record<EntryState, number>)[e.state] += 1;
    }
    return c;
  }, [entries]);

  async function setActiveEntryState(newState: EntryState) {
    if (!active) return;
    const res = await fetch(`/api/entries/${active.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: draftText,
        glosses: draftGlosses,
        state: newState,
      }),
    });
    const d = await res.json();
    setEntries((prev) => prev.map((e) => (e.id === active.id ? d.entry : e)));

    if (newState !== "pending") {
      const next = entries.find(
        (e) =>
          e.id !== active.id &&
          e.state === "pending" &&
          (tab === "all" || e.state === tab),
      );
      if (next) setActiveId(next.id);
    }
    fetch("/api/pages")
      .then((r) => r.json())
      .then((d) => setPages(d.pages || []));
  }

  async function exportPage() {
    if (currentPage === null) return;
    const res = await fetch(`/api/export/page/${currentPage}`, {
      method: "POST",
    });
    if (!res.ok) {
      alert("Export failed: " + (await res.text()));
      return;
    }
    triggerDownload(
      await res.blob(),
      `page_${String(currentPage).padStart(3, "0")}.xlsx`,
    );
  }

  async function exportAll() {
    const res = await fetch(`/api/export`, { method: "POST" });
    if (!res.ok) {
      alert("Export failed: " + (await res.text()));
      return;
    }
    triggerDownload(await res.blob(), "validated_predictions.xlsx");
  }

  // Pending entries on this page whose text doesn't contain U/O/V — these are
  // safe one-click candidates for marking no_ouv (out of scope for the
  // exported deliverable). Same content rule the OCR pipeline uses to filter.
  const noOuvCandidates = useMemo(
    () => entries.filter((e) => e.state === "pending" && !hasOUV(e.text)),
    [entries],
  );

  async function autoMarkNoOuv() {
    if (noOuvCandidates.length === 0) return;
    const ok = window.confirm(
      `Mark ${noOuvCandidates.length} pending ${
        noOuvCandidates.length === 1 ? "entry" : "entries"
      } without U/O/V as no_ouv?`,
    );
    if (!ok) return;

    await Promise.all(
      noOuvCandidates.map((e) =>
        fetch(`/api/entries/${e.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: "no_ouv" }),
        }),
      ),
    );
    // Refetch this page's entries + the page summary counts.
    if (currentPage !== null) {
      fetch(`/api/entries?page=${currentPage}`)
        .then((r) => r.json())
        .then((d) => setEntries(d.entries || []));
    }
    fetch("/api/pages")
      .then((r) => r.json())
      .then((d) => setPages(d.pages || []));
  }

  function updateGloss(i: number, value: string) {
    setDraftGlosses((prev) => prev.map((g, j) => (j === i ? value : g)));
  }
  function removeGloss(i: number) {
    setDraftGlosses((prev) => prev.filter((_, j) => j !== i));
  }
  function addGloss() {
    setDraftGlosses((prev) => [...prev, ""]);
  }

  const isModifiedText =
    active && active.predTextRaw !== null && draftText !== active.predTextRaw;
  const isModifiedGloss =
    active &&
    active.predGlossRaw !== null &&
    joinGlosses(draftGlosses) !== active.predGlossRaw;

  return (
    <ResizablePanelGroup
      direction="horizontal"
      className="h-screen overflow-hidden bg-background text-foreground"
      autoSaveId="labeler-layout-v2"
    >
      {/* SIDE PANEL — entry list (navigation only) */}
      <ResizablePanel
        defaultSize={18}
        minSize={14}
        maxSize={35}
        className="bg-card flex flex-col overflow-hidden"
      >
        <header className="px-4 h-14 flex items-center justify-between border-b border-border flex-shrink-0">
          <span className="text-sm font-semibold tracking-tight">
            Text Definition Labeler
          </span>
          <Button
            onClick={() => signOut({ callbackUrl: "/login" })}
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span className="sr-only">sign out</span>
          </Button>
        </header>

        <div className="px-4 py-3 border-b border-border space-y-3 flex-shrink-0">
          <div>
            <Label className="mb-1.5 block">Page</Label>
            <Select
              value={currentPage?.toString() ?? ""}
              onValueChange={(v) => setCurrentPage(Number(v))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a page" />
              </SelectTrigger>
              <SelectContent>
                {pages.map((p) => (
                  <SelectItem key={p.page} value={p.page.toString()}>
                    page {p.page} &nbsp;
                    <span className="text-muted-foreground">
                      [{p.accepted}/{p.total} accepted]
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 text-[11px]">
            <CountChip label="pending" value={counts.pending} />
            <CountChip label="done" value={counts.accepted} accent="emerald" />
            <CountChip label="rejected" value={counts.rejected} accent="rose" />
            <CountChip label="no_ouv" value={counts.no_ouv} accent="amber" />
          </div>
        </div>

        <div className="px-3 py-2 border-b border-border flex-shrink-0">
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <TabsList className="w-full">
              {(
                ["all", "pending", "accepted", "rejected", "no_ouv"] as Tab[]
              ).map((t) => (
                <TabsTrigger key={t} value={t} className="flex-1">
                  {t === "no_ouv"
                    ? "No OUV"
                    : t.charAt(0).toUpperCase() + t.slice(1)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        <ul className="flex-1 min-h-0 overflow-y-auto">
          {filtered.map((e) => {
            const isActive = activeId === e.id;
            return (
              <li
                key={e.id}
                onClick={() => setActiveId(e.id)}
                className={cn(
                  "px-4 py-2.5 border-b border-border cursor-pointer flex items-start gap-3 transition-colors",
                  isActive ? "bg-accent" : "hover:bg-muted/50",
                )}
              >
                <span className="font-mono text-[10px] text-muted-foreground w-5 flex-shrink-0 mt-0.5 tabular-nums">
                  {e.entryIdx}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-center gap-2">
                    <span className="font-medium text-sm truncate">
                      {e.text}
                    </span>
                    <Badge
                      className={cn(
                        "flex-shrink-0",
                        STATE_BADGE_CLASS[e.state],
                      )}
                    >
                      {STATE_LABELS[e.state]}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground truncate italic mt-0.5">
                    {e.glossRaw || (
                      <span className="opacity-60">(empty gloss)</span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
          {!filtered.length && (
            <li className="px-3 py-12 text-center text-muted-foreground text-sm">
              No entries in this tab.
            </li>
          )}
        </ul>

        <div className="px-3 py-3 border-t border-border flex-shrink-0 space-y-2">
          <Button
            onClick={autoMarkNoOuv}
            variant="outline"
            disabled={noOuvCandidates.length === 0}
            className="w-full"
            title="Mark all pending entries on this page whose text doesn't contain U, O, or V as no_ouv."
          >
            <Wand2 className="h-3.5 w-3.5" />
            Auto-mark no_ouv{" "}
            {noOuvCandidates.length > 0 && (
              <span className="ml-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-semibold px-1.5">
                {noOuvCandidates.length}
              </span>
            )}
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={exportPage} variant="outline" className="w-full">
              <FileSpreadsheet className="h-3.5 w-3.5" />
              This page
            </Button>
            <Button onClick={exportAll} className="w-full">
              <Download className="h-3.5 w-3.5" />
              All accepted
            </Button>
          </div>
        </div>
      </ResizablePanel>

      <ResizableHandle />

      {/* EDIT FORM PANEL */}
      <ResizablePanel
        defaultSize={25}
        minSize={18}
        maxSize={45}
        className="bg-card flex flex-col overflow-hidden"
      >
        {/* Persistent header bar — same h-14 as the side panel title bar so they
            line up across the resizable handle. */}
        <header className="px-5 h-14 flex items-center justify-between gap-3 border-b border-border flex-shrink-0">
          {active ? (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground">
                  page{" "}
                  <span className="font-semibold text-foreground">
                    {active.page}
                  </span>{" "}
                  · entry{" "}
                  <span className="font-semibold text-foreground">
                    {active.entryIdx}
                  </span>
                </span>
                <Badge className={STATE_BADGE_CLASS[active.state]}>
                  {STATE_LABELS[active.state]}
                </Badge>
              </div>
              {active.snappedFrom && (
                <div className="text-[11px] text-muted-foreground truncate">
                  snapped from <s>{active.snappedFrom}</s>
                </div>
              )}
            </>
          ) : (
            <span className="text-sm text-muted-foreground">
              No entry selected
            </span>
          )}
        </header>
        {!active ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm px-8 text-center">
            Pick an entry from the list to edit it and verify against the page.
          </div>
        ) : (
          <div className="flex flex-col overflow-hidden flex-1">
            {/* Form body — scrollable */}
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="entry-text">Text</Label>
                <Input
                  id="entry-text"
                  value={draftText}
                  onChange={(ev) => setDraftText(ev.target.value)}
                  className={cn(
                    "font-mono",
                    isModifiedText && "border-amber-400",
                  )}
                />
                {isModifiedText && (
                  <p className="text-[11px] text-amber-700">
                    edited from{" "}
                    <span className="font-mono">{active.predTextRaw}</span>
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Glosses ({draftGlosses.length})</Label>
                  <span className="text-[10px] text-muted-foreground normal-case tracking-normal">
                    joined with “. ” on export
                  </span>
                </div>
                <div className="space-y-1.5">
                  {draftGlosses.map((g, i) => (
                    <div key={i} className="flex gap-1.5">
                      <Input
                        value={g}
                        onChange={(ev) => updateGloss(i, ev.target.value)}
                        placeholder={`gloss ${i + 1}`}
                        className={cn(
                          "font-mono italic",
                          isModifiedGloss && "border-amber-400",
                        )}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => removeGloss(i)}
                        aria-label={`remove gloss ${i + 1}`}
                        className="text-muted-foreground hover:text-destructive flex-shrink-0"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                  {draftGlosses.length === 0 && (
                    <p className="text-xs text-muted-foreground italic">
                      (no glosses)
                    </p>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addGloss}
                    className="w-full border-dashed text-muted-foreground"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add gloss
                  </Button>
                </div>
                {isModifiedGloss && (
                  <p className="text-[11px] text-amber-700">
                    gloss list differs from prediction
                  </p>
                )}
              </div>
            </div>

            {/* Action strip — soft semantic palette, each button color matches
                   the badge it produces in the entry list. */}
            <div className="px-5 py-3 border-t border-border flex-shrink-0 grid grid-cols-2 gap-2">
              <Button
                onClick={() => setActiveEntryState("accepted")}
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                Accept
              </Button>
              <Button
                onClick={() => setActiveEntryState("rejected")}
                className="bg-rose-500 hover:bg-rose-600 text-white"
              >
                Reject
              </Button>
              <Button
                onClick={() => setActiveEntryState("no_ouv")}
                variant="outline"
                className="border-amber-300 text-amber-700 hover:bg-amber-50 hover:text-amber-800"
              >
                No OUV
              </Button>
              <Button
                onClick={() => setActiveEntryState("pending")}
                variant="ghost"
                className="text-muted-foreground"
              >
                Reset
              </Button>
            </div>
          </div>
        )}
      </ResizablePanel>

      <ResizableHandle />

      {/* PAGE IMAGE PANEL — drag to pan (bounded), scroll-wheel or buttons to zoom */}
      <ResizablePanel
        defaultSize={35}
        minSize={18}
        className="relative overflow-hidden"
      >
        {currentPage === null ? (
          <div className="text-center text-muted-foreground mt-32 text-sm">
            No page selected.
          </div>
        ) : (
          <>
            {/* Padding wrapper sits OUTSIDE the TransformWrapper so the library's
                bounds calculation uses the inner box (no padding offset) — the
                visible breathing room is purely visual. */}
            <div className="absolute inset-0 p-4">
              <TransformWrapper
                ref={zoomRef}
                key={currentPage}
                minScale={0.5}
                maxScale={5}
                initialScale={1}
                centerOnInit
                centerZoomedOut
                limitToBounds
                wheel={{ step: 0.1 }}
                doubleClick={{ disabled: false, mode: "reset" }}
                panning={{ velocityDisabled: true }}
                velocityAnimation={{ disabled: true }}
                alignmentAnimation={{ disabled: true }}
              >
                <TransformComponent
                  wrapperClass="!w-full !h-full !cursor-grab active:!cursor-grabbing !border !border-border"
                  contentClass="!w-full !h-full !flex !items-center !justify-center"
                >
                  {/* Image gets max-w-full + max-h-full so its NATURAL display size
                    fits the wrapper exactly. The library's bounds calc then uses
                    this fit-size as the scale=1 reference, so panning extents
                    grow proportionally with zoom. */}
                  <img
                    src={`/api/page-image/${currentPage}`}
                    alt={`page ${currentPage}`}
                    className="block max-w-full max-h-full object-contain select-none border border-border bg-white shadow-sm"
                    draggable={false}
                  />
                </TransformComponent>
              </TransformWrapper>
            </div>

            {/* Zoom controls — top-right */}
            <div className="absolute right-3 top-3 flex items-center gap-1 border border-border bg-card/95 p-1 shadow-sm">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => zoomRef.current?.zoomIn()}
                aria-label="zoom in"
              >
                <ZoomIn className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => zoomRef.current?.zoomOut()}
                aria-label="zoom out"
              >
                <ZoomOut className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => zoomRef.current?.resetTransform()}
                aria-label="fit to view"
                title="reset to fit"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="pointer-events-none absolute left-3 bottom-3 border border-border bg-card/95 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground shadow-sm">
              drag to pan · scroll to zoom · double-click to reset
            </div>
          </>
        )}
      </ResizablePanel>

      <ResizableHandle />

      {/* RECONSTRUCTION PANEL — AI-ranked PMP cognate candidates for the
          active entry. Reads from Postgres cache; on miss, the operator hits
          "Attempt with AI" which POSTs to the Python service. */}
      <ResizablePanel
        defaultSize={22}
        minSize={16}
        maxSize={40}
        className="overflow-hidden"
      >
        <ReconstructionPanel
          entry={
            active
              ? {
                  id: active.id,
                  text: active.text,
                  glossRaw: active.glossRaw,
                  state: active.state,
                }
              : null
          }
          reloadKey={reconReloadKey}
          onBrowseAcd={
            active
              ? (prefix) =>
                  setDictionaryDrawer({ entryId: active.id, prefix })
              : undefined
          }
        />
      </ResizablePanel>
      {dictionaryDrawer !== null && (
        <DictionaryDrawer
          entryId={dictionaryDrawer.entryId}
          prefix={dictionaryDrawer.prefix}
          onClose={() => {
            setDictionaryDrawer(null);
            // Force the recon panel to refetch so any picks added in
            // the drawer become visible in the candidate list / manual
            // picks section without a manual refresh.
            setReconReloadKey((k) => k + 1);
          }}
          onPickChanged={() => setReconReloadKey((k) => k + 1)}
        />
      )}
    </ResizablePanelGroup>
  );
}

function DictionaryDrawer({
  entryId,
  prefix,
  onClose,
  onPickChanged,
}: {
  entryId: number;
  prefix: string;
  onClose: () => void;
  onPickChanged: () => void;
}) {
  // Esc closes the drawer — keyboard escape hatch matching the X button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      {/* Backdrop is non-interactive: clicks here intentionally do
          NOTHING. The user lost picks once after accidentally clicking
          out while scanning a long row — only the explicit close
          button (or Esc) dismisses the drawer now. */}
      <div
        aria-hidden="true"
        className="flex-1 bg-black/40 backdrop-blur-[1px]"
      />
      <div className="w-[min(96vw,72rem)] bg-background shadow-2xl flex flex-col">
        <DictionaryView
          entryId={entryId}
          initialPrefix={prefix}
          closeLabel="close"
          onClose={onClose}
          onPickChanged={onPickChanged}
        />
      </div>
    </div>
  );
}

function CountChip({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: "emerald" | "rose" | "amber";
}) {
  const accentMap: Record<string, string> = {
    emerald: "text-emerald-700",
    rose: "text-rose-700",
    amber: "text-amber-700",
  };
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <span>{label}</span>
      <span
        className={cn(
          "font-semibold",
          accent && accentMap[accent],
          !accent && "text-foreground",
        )}
      >
        {value}
      </span>
    </span>
  );
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
