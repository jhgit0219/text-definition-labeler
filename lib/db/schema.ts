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
