# Reconstruction in the Labeler — Design

**Date:** 2026-05-09
**Status:** Design accepted, ready for implementation planning
**Sibling project:** `../bisaya-reconstruction/` — provides the AI ranking pipeline (`acd_ingest.labeler_api.reconstruct`)

## Goal

Add a proto-form reconstruction workflow to the existing accept/reject labeler. For each accepted text-gloss pair, surface the top 5–7 PMP/PAn cognate candidates the bisaya-reconstruction AI agent identified, let the annotator pick one (or several, for doublets) plus jot a freeform note, and carry the picks through the xlsx export so downstream linguistic analysis can use them.

## Scope

- Pages 1–23: text-gloss pairs already validated in an external spreadsheet; one-shot import into Postgres with `state='accepted'`.
- Pages 23–26: already accepted via the labeler UI.
- 44 word reconstructions exist today in the bisaya-reconstruction SQLite cache (`data/cache/llm_responses.sqlite`); one-shot migration into Postgres.
- All other accepted entries: reconstruction computed on demand via a Python service.

## Architecture

```
                                                  ┌──────────────────────┐
                                                  │ bisaya-reconstruction│
                                                  │   (Python)           │
┌────────────────┐  GET /api/recon/:entry_id      │                      │
│ Labeler UI     │ ───────────────►  ┌─────────┐  │ FastAPI service      │
│ (Next.js)      │                   │ Postgres│  │ wraps                │
│                │ ◄─────────────── │ recon   │  │ labeler_api.         │
│ 4th panel:     │  rankings JSON    │ table   │  │   reconstruct()      │
│  - candidates  │                   └─────────┘  │                      │
│  - notes       │                        ▲       │ on miss:             │
│  - picks       │                        │       │  - calls Claude API  │
└────────────────┘                        │       │  - INSERTs row       │
        │                                 │       │  - returns JSON      │
        │ POST /api/recon/:entry_id       └───────┤                      │
        └────────────────────────────►            │                      │
              "Attempt with AI"                   └──────────────────────┘
```

Two persistence stores keep their existing roles:
- **SQLite `LLMCache`** stays in bisaya-reconstruction for bench/CLI work
- **Postgres** is the labeler's source of truth; the Python service writes here

## Data model

### New: `reconstructions` (AI rankings, keyed by text+gloss)

```ts
reconstructions = pgTable("reconstructions", {
  id: serial("id").primaryKey(),
  text: text("text").notNull(),
  gloss: text("gloss").notNull(),           // normalized: trim + collapse spaces
  modelId: varchar("model_id", { length: 64 }).notNull(),     // 'claude-opus-4-7'
  promptVersion: varchar("prompt_version", { length: 16 }).notNull(),  // 'v2-agent'
  rankings: jsonb("rankings").notNull(),    // [{pidno, rank, confidence, rationale, is_match, proto_form, proto_form_plain, gloss_text, set_num, sample_reflexes:[...]}]
  status: varchar("status", {length:16}).notNull().default("done"),  // 'queued' | 'done' | 'error'
  errorMsg: text("error_msg"),
  computedAt: timestamp("computed_at", {withTimezone:true}).notNull().defaultNow(),
}, t => ({
  textGlossUniq: uniqueIndex("recon_text_gloss_model_uniq")
    .on(t.text, t.gloss, t.modelId, t.promptVersion),
}));
```

Why keyed by (text, gloss) not entry_id: the same word appears on multiple pages, but the AI ranking depends only on the text-gloss pair. One computation, shared across entries.

### New: `entry_reconstruction_picks` (annotator's selections, per entry)

```ts
entryReconstructionPicks = pgTable("entry_reconstruction_picks", {
  id: serial("id").primaryKey(),
  entryId: integer("entry_id").notNull()
    .references(() => entries.id, {onDelete:"cascade"}),
  reconstructionId: integer("reconstruction_id").notNull()
    .references(() => reconstructions.id),
  pidno: integer("pidno").notNull(),         // which candidate inside rankings
  protoForm: text("proto_form").notNull(),   // denormalized for export
  isPrimary: boolean("is_primary").notNull().default(true),
  createdAt: timestamp("created_at", {withTimezone:true}).notNull().defaultNow(),
}, t => ({
  entryPidnoUniq: uniqueIndex("entry_pick_uniq").on(t.entryId, t.pidno),
}));
```

Zero rows for an entry = not yet annotated. One row = single cognate (the common case). Multiple rows = doublet or alternate hypothesis; exactly one has `isPrimary=true`.

### Schema change: `entries.notes`

Add a single `notes: text` column to `entries` for freeform annotator commentary. Per-entry, not per-pick (matches the "single textbox" UX).

## Workflows

### 1. One-shot spreadsheet import (pages 1–23)

A Python script in bisaya-reconstruction reads the schwa spreadsheet and upserts into the labeler Postgres `entries` table:

```python
# bench/import_spreadsheet_to_labeler.py
for row in spreadsheet:
    UPSERT entries (page, entry_idx, text, gloss_raw, glosses, state='accepted', source='spreadsheet_v1')
    ON CONFLICT (page, entry_idx) DO UPDATE
      SET text=excluded.text, gloss_raw=..., state='accepted'
```

Connection string read from labeler `.env.local` `DATABASE_URL` (script reads, does not commit).

### 2. One-shot SQLite → Postgres recon migration

Adapt `bench/ingest_to_cache.py` to target Postgres instead of SQLite. Iterates the 44 existing bench-result JSON files, rebuilds `RankedResult` from the parsed CSVs, INSERTs into `reconstructions`.

### 3. On-demand compute (cache miss)

Python FastAPI service exposes:

```
POST /reconstruct
Body: { "text": "Apdo", "gloss": "Hiel." }
->   { "rankings": [...], "model_id": "claude-opus-4-7", "prompt_template_version": "v2-agent", "cache_hit": bool }
```

Implementation wraps `acd_ingest.labeler_api.reconstruct()` (already built in iter-5). On return, the service writes the row to Postgres `reconstructions` AND keeps the SQLite cache row (dual-write, no extra cost).

Hosting: starts as `localhost:8000` for development; production deployment is deferred (see Open Questions).

### 4. Next.js API surface

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/recon/:entry_id` | Returns the cached `reconstructions` row for this entry's (text, gloss), plus current picks. 404 if no row exists yet. |
| POST | `/api/recon/:entry_id` | "Attempt with AI" — calls Python service, INSERTs result, returns it. 409 if a `done` row already exists (caller should refresh). |
| PUT | `/api/recon/:entry_id/picks` | Replace the entry's pick set. Body: `{picks: [{pidno, isPrimary}], notes: "..."}`. Transactional: deletes existing picks, inserts new ones, updates `entries.notes`. |

### 5. UI: 4th panel

Add a `<ResizablePanel>` to the right of the page-image panel in [app/(authed)/review/page.tsx](app/(authed)/review/page.tsx#L576).

Default sizes: sidebar 18 / form 25 / image 35 / reconstruction 22 (page image panel shrinks from 50 → 35).

Panel states:
1. **No entry selected** → "Pick an entry from the list."
2. **Entry not yet accepted** → "Reconstruction is shown after accepting the text + gloss."
3. **Entry accepted, no `reconstructions` row** → "No reconstruction yet for *Apdo / Hiel.*  [Attempt with AI]"
4. **Status `queued`** (only if we add async worker later) → spinner + "Reconstructing…"
5. **Status `done`** → header (model, prompt version, computed_at) + checkbox list of candidates + notes textbox + Save button
6. **Status `error`** → error message + retry button

Candidate row shape:

```
☑ ⭐ [1] *buhek 95%      'head hair'                        pidno 1500
   Cebuano buhok 'hair'; Tagalog buhok 'hair'; Bikol buhok.
   Schwa-hypothesis: SJ o-graph reflects *e, regular Cebuano.

☐ ⭐ [2] *bukbuk₃ 5%      'weevil; pound to powder'         pidno 1489
   ...
```

- Checkbox toggles inclusion in picks
- Star icon (`⭐`) toggles `isPrimary`; constrained so exactly one checked pick has the star at any time
- Rationale wraps below the header on its own line; sample reflexes shown collapsed (expand on hover/click)
- Save button writes via PUT `/api/recon/:entry_id/picks`; disabled until something changes; shows "Saved ✓" inline after success

Keyboard: `1`–`7` toggle a checkbox; `Shift+1`–`7` set primary; `Ctrl+S` saves.

## Export changes

[lib/xlsx.ts](lib/xlsx.ts) adds four columns to the accepted-entries sheet:

```
| page | entry | text  | gloss        | primary_proto | alt_protos | notes        | pidnos    |
|------|-------|-------|--------------|---------------|------------|--------------|-----------|
| 17   | 3     | Babuy | Puerco       | *babuy₃       |            |              | 441       |
| 4    | 2     | Balico| Torzido      | *balíkes      | *likuq     | doublet      | 599;3486  |
| 30   | 1     | Bogarug| Cerrojo     |               |            | no cognate   |           |
```

- `primary_proto`: the `isPrimary=true` pick (string, blank if none)
- `alt_protos`: semicolon-joined non-primary picks
- `notes`: `entries.notes` freeform
- `pidnos`: semicolon-joined pidnos for round-tripping back to ACD

Rows with no picks still export (blank cells) — keeps the export usable as a progress snapshot. Optional filter switch on `POST /api/export?picks_only=true` for the deliverable cut.

## Open questions (defer until implementation)

1. **Python service hosting in production.** Localhost works for development. Vercel can't host the Python service directly. Options: Railway/Render/Fly.io for a small Python container, or a local-only "compute" mode where the production labeler can READ but the "Attempt with AI" button is disabled unless a Python service URL is configured.
2. **Async worker vs sync POST.** Current plan: sync (Next.js POST → Python → wait → response, ~10–60s). If that's too slow in the UI, switch to a queued model where POST returns immediately with `status='queued'` and the UI polls.
3. **Re-run on text/gloss edit.** If the annotator edits an accepted entry's text or gloss after the reconstruction was computed, the cache row is stale. Plan: surface a "text/gloss changed, reconstruction may be outdated [Re-run]" banner; don't auto-invalidate.
4. **Cache hit vs miss telemetry.** Track how many entries are cache hits vs live calls so we can monitor API spend as the corpus grows toward 2400 words.

## Implementation order (rough)

1. Add the two tables + `entries.notes` column via Drizzle migration
2. Spreadsheet importer (Python → labeler Postgres, `entries` upsert)
3. SQLite → Postgres `reconstructions` migration script
4. Python FastAPI service wrapping `labeler_api.reconstruct`
5. Next.js API routes (GET / POST / PUT `/api/recon/:entry_id`)
6. 4th UI panel + candidate list + notes + save flow
7. Export column additions in `lib/xlsx.ts`
8. End-to-end test on one entry (Babuy → cache hit → UI → save pick → export)

Hand off from here to `/dev-studio` for the full implementation plan with task breakdown, estimates, and execution.
