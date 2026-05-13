CREATE TABLE IF NOT EXISTS "entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"page" integer NOT NULL,
	"entry_idx" integer NOT NULL,
	"text" text NOT NULL,
	"gloss_raw" text NOT NULL,
	"glosses" text[] DEFAULT '{}' NOT NULL,
	"state" varchar(16) DEFAULT 'pending' NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"is_multi_region" boolean DEFAULT false NOT NULL,
	"pred_text_raw" text,
	"pred_gloss_raw" text,
	"snapped_from" text,
	"bbox_regions" jsonb,
	"source" varchar(32) DEFAULT 'qwen_v2' NOT NULL,
	"notes" text,
	"spreadsheet_protos" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entry_reconstruction_picks" (
	"id" serial PRIMARY KEY NOT NULL,
	"entry_id" integer NOT NULL,
	"reconstruction_id" integer NOT NULL,
	"pidno" integer NOT NULL,
	"proto_form" text NOT NULL,
	"is_primary" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reconstructions" (
	"id" serial PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"gloss" text NOT NULL,
	"model_id" varchar(64) NOT NULL,
	"prompt_version" varchar(16) NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"rankings" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'done' NOT NULL,
	"error_msg" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entry_reconstruction_picks" ADD CONSTRAINT "entry_reconstruction_picks_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entry_reconstruction_picks" ADD CONSTRAINT "entry_reconstruction_picks_reconstruction_id_reconstructions_id_fk" FOREIGN KEY ("reconstruction_id") REFERENCES "public"."reconstructions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "entries_page_entry_idx_unique" ON "entries" USING btree ("page","entry_idx");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entries_page_idx" ON "entries" USING btree ("page");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entries_text_idx" ON "entries" USING btree ("text");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entries_state_idx" ON "entries" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "entry_pick_uniq" ON "entry_reconstruction_picks" USING btree ("entry_id","pidno");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entry_pick_entry_idx" ON "entry_reconstruction_picks" USING btree ("entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "recon_text_gloss_model_uniq" ON "reconstructions" USING btree ("text","gloss","model_id","prompt_version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recon_text_gloss_idx" ON "reconstructions" USING btree ("text","gloss");