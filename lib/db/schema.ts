import {
  pgTable,
  serial,
  integer,
  text,
  varchar,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * One row per dictionary entry inferred from the manuscript. The model's
 * raw prediction is preserved (predTextRaw / predGlossRaw) alongside any
 * human correction (text / gloss). When `edited` is false, text == predTextRaw.
 *
 * `glosses` is the parsed list — periods between Spanish definitions are
 * split into array elements at import time, so queries like "find all
 * entries with gloss 'Curtir'" can use the GIN index.
 *
 * `state` controls inclusion in the deliverable export:
 *   - 'accepted'  -> exports
 *   - 'rejected'  -> kept in DB for retraining, never exported
 *   - 'no_ouv'    -> out of scope (no U/O/V), kept for retraining
 *   - 'pending'   -> not yet reviewed
 *
 * `notes` carries freeform annotator commentary, populated alongside the
 * reconstruction picks (one note per entry, not per pick).
 *
 * `spreadsheetProtos` is non-null only for rows imported from the schwa
 * reference spreadsheet. Shape: { pan, pmp, pcph, pb, status, notes } where
 * each proto layer is the spreadsheet's recorded reconstruction at that
 * proto-language depth. Surfaced in the labeler as a read-only reference
 * card above the AI candidates.
 */
export const entries = pgTable(
  "entries",
  {
    id: serial("id").primaryKey(),
    page: integer("page").notNull(),
    entryIdx: integer("entry_idx").notNull(),
    text: text("text").notNull(),
    glossRaw: text("gloss_raw").notNull(), // original period-separated string
    glosses: text("glosses").array().notNull().default([]), // parsed array
    state: varchar("state", { length: 16 }).notNull().default("pending"),
    edited: boolean("edited").notNull().default(false),
    isMultiRegion: boolean("is_multi_region").notNull().default(false),
    predTextRaw: text("pred_text_raw"),
    predGlossRaw: text("pred_gloss_raw"),
    snappedFrom: text("snapped_from"), // prior pred before dict-snap fired
    bboxRegions: jsonb("bbox_regions"), // [{page, bbox: [x,y,w,h]}, ...]
    source: varchar("source", { length: 32 }).notNull().default("qwen_v2"),
    notes: text("notes"),
    spreadsheetProtos: jsonb("spreadsheet_protos"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pageEntryIdxUnique: uniqueIndex("entries_page_entry_idx_unique").on(t.page, t.entryIdx),
    pageIdx: index("entries_page_idx").on(t.page),
    textIdx: index("entries_text_idx").on(t.text),
    stateIdx: index("entries_state_idx").on(t.state),
    // Drizzle GIN array index — declare via raw SQL when generating migrations:
    // CREATE INDEX entries_glosses_gin ON entries USING GIN (glosses);
  })
);

export type Entry = typeof entries.$inferSelect;
export type NewEntry = typeof entries.$inferInsert;

/**
 * Cached AI rankings, keyed by (text, gloss, modelId, promptVersion).
 *
 * One row holds a complete ranked candidate list for a text/gloss pair —
 * not one row per candidate. The full list lives in `rankings` (jsonb)
 * conforming to the Zod schema in `lib/recon/rankings-schema.ts`. Multiple
 * `entries` rows can share a single `reconstructions` row when the same
 * Bisaya word recurs across manuscript pages.
 *
 * `schemaVersion` lets the rankings shape evolve without breaking existing
 * rows: bump it whenever the JSON contract changes, and read code can
 * branch on the version to migrate older payloads on the fly.
 *
 * `status` distinguishes 'done' (rankings present) from 'queued' (worker
 * picked up; rankings null) and 'error' (compute failed; errorMsg set).
 * The initial implementation writes 'done' directly on the synchronous
 * dual-write path; 'queued' is reserved for a future async worker.
 */
export const reconstructions = pgTable(
  "reconstructions",
  {
    id: serial("id").primaryKey(),
    text: text("text").notNull(),
    gloss: text("gloss").notNull(),
    modelId: varchar("model_id", { length: 64 }).notNull(),
    promptVersion: varchar("prompt_version", { length: 16 }).notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    rankings: jsonb("rankings").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("done"),
    errorMsg: text("error_msg"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    textGlossModelUnique: uniqueIndex("recon_text_gloss_model_uniq").on(
      t.text,
      t.gloss,
      t.modelId,
      t.promptVersion,
    ),
    textGlossIdx: index("recon_text_gloss_idx").on(t.text, t.gloss),
  })
);

export type Reconstruction = typeof reconstructions.$inferSelect;
export type NewReconstruction = typeof reconstructions.$inferInsert;

/**
 * Per-entry annotator picks. Zero rows for an entry = not yet annotated.
 * One row = single cognate (the common case). Multiple rows = doublet or
 * alternate hypothesis; exactly one has isPrimary=true.
 *
 * `protoForm` is denormalized from the linked reconstruction's rankings
 * payload so the xlsx export does not need to join through the jsonb on
 * every row.
 */
export const entryReconstructionPicks = pgTable(
  "entry_reconstruction_picks",
  {
    id: serial("id").primaryKey(),
    entryId: integer("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    reconstructionId: integer("reconstruction_id")
      .notNull()
      .references(() => reconstructions.id),
    pidno: integer("pidno").notNull(),
    protoForm: text("proto_form").notNull(),
    isPrimary: boolean("is_primary").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entryPidnoUnique: uniqueIndex("entry_pick_uniq").on(t.entryId, t.pidno),
    entryIdx: index("entry_pick_entry_idx").on(t.entryId),
  })
);

export type EntryReconstructionPick = typeof entryReconstructionPicks.$inferSelect;
export type NewEntryReconstructionPick = typeof entryReconstructionPicks.$inferInsert;
