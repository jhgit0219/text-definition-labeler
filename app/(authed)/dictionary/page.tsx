"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo } from "react";

import { DictionaryView } from "@/components/dictionary/DictionaryView";

/**
 * /dictionary route — a thin URL-driven wrapper around DictionaryView.
 * Reads entry_id, prefix, and layers from the query string for initial
 * state, and navigates back to /review (carrying entry_id through) on
 * close. DictionaryView is also used directly by the recon panel's
 * drawer; this page keeps the same surface deep-linkable for bookmarks
 * and shared URLs.
 */
export default function DictionaryPageWrapper() {
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
  const prefixParam = (searchParams.get("prefix") || "ab").toLowerCase();
  const layersParam = searchParams.get("layers") || "";

  const entryId = useMemo(() => {
    if (!entryIdParam) return null;
    const n = Number.parseInt(entryIdParam, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [entryIdParam]);

  const initialLayers = useMemo(
    () =>
      layersParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    [layersParam],
  );

  return (
    <div className="h-screen">
      <DictionaryView
        entryId={entryId}
        initialPrefix={prefixParam}
        initialLayers={initialLayers}
        onClose={() =>
          router.push(
            entryId !== null ? `/review?entry_id=${entryId}` : "/review",
          )
        }
      />
    </div>
  );
}
