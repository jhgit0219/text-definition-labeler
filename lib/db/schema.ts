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
    /**
     * Snapshot of the originating entry's `state` at the moment this
     * reconstruction was first computed. NULL means "computed via the
     * direct labeler API path (state-agnostic) or backfilled before this
     * column existed". When non-null and != 'accepted', the panel surfaces
     * a banner telling the annotator that the ranking was generated
     * before the text-gloss pair was validated.
     */
    computedAgainstState: varchar("computed_against_state", { length: 16 }),
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
    // Nullable because picks can originate from two paths:
    //   (a) AI ranking — reconstructionId set, pointing at the rankings row
    //       the candidate came from
    //   (b) manual browse-ACD — reconstructionId is null; the annotator
    //       picked the proto-form directly from /dictionary without an
    //       AI ranking backing it
    reconstructionId: integer("reconstruction_id").references(
      () => reconstructions.id,
    ),
    pidno: integer("pidno").notNull(),
    protoForm: text("proto_form").notNull(),
    isPrimary: boolean("is_primary").notNull().default(true),
    source: varchar("source", { length: 16 }).notNull().default("ai"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entryPidnoUnique: uniqueIndex("entry_pick_uniq").on(t.entryId, t.pidno),
    entryIdx: index("entry_pick_entry_idx").on(t.entryId),
  })
);

export type EntryReconstructionPick = typeof entryReconstructionPicks.$inferSelect;
export type NewEntryReconstructionPick = typeof entryReconstructionPicks.$inferInsert;

/**
 * Full ACD reconstruction corpus, imported once from the parsed CSVs in
 * the sibling bisaya-reconstruction repo (~12K rows). Used by the
 * /dictionary route's letter-by-letter browse view.
 *
 * Distinct from `reconstructions` (the AI rankings cache): that table
 * stores ranked candidate LISTS produced by the agent per (text, gloss);
 * this table stores the underlying canonical reconstructions themselves,
 * one row per ACD entry. The agent's ranked candidates reference these
 * via `pidno`.
 *
 * `firstLetter` is a denormalized lowercase ASCII initial of `formPlain`,
 * computed at import time. Lets the browse view filter by letter without
 * a regex lambda on every query.
 */
export const acdReconstructions = pgTable(
  "acd_reconstructions",
  {
    pidno: integer("pidno").primaryKey(),
    protoCode: text("proto_code").notNull(),
    form: text("form").notNull(),
    formPlain: text("form_plain").notNull(),
    glossText: text("gloss_text").notNull(),
    setNum: integer("set_num").notNull(),
    firstLetter: varchar("first_letter", { length: 4 }).notNull(),
  },
  (t) => ({
    firstLetterIdx: index("acd_recon_first_letter_idx").on(t.firstLetter),
    setNumIdx: index("acd_recon_set_num_idx").on(t.setNum),
    formPlainIdx: index("acd_recon_form_plain_idx").on(t.formPlain),
  }),
);

export type AcdReconstruction = typeof acdReconstructions.$inferSelect;
export type NewAcdReconstruction = typeof acdReconstructions.$inferInsert;

/**
 * Daughter-language reflexes for each ACD reconstruction. ~107K rows.
 * Loaded on-demand when the annotator expands a reconstruction in the
 * /dictionary view.
 */
export const acdReflexes = pgTable(
  "acd_reflexes",
  {
    id: serial("id").primaryKey(),
    pidno: integer("pidno")
      .notNull()
      .references(() => acdReconstructions.pidno, { onDelete: "cascade" }),
    /**
     * Major branch of Austronesian as labeled by ACD:
     *   Formosan, WMP, CMP, SHWNG, OC
     * Used by the dictionary + recon panel to bucket large reflex lists.
     * Defaulted blank for any rows where the CSV happens to have no code,
     * which the UI groups under "Other".
     */
    subgroupCode: varchar("subgroup_code", { length: 16 }).notNull().default(""),
    languageName: text("language_name").notNull(),
    form: text("form").notNull(),
    formPlain: text("form_plain").notNull(),
    glossText: text("gloss_text").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => ({
    pidnoIdx: index("acd_reflex_pidno_idx").on(t.pidno),
  }),
);

export type AcdReflex = typeof acdReflexes.$inferSelect;
export type NewAcdReflex = typeof acdReflexes.$inferInsert;
