CREATE TABLE IF NOT EXISTS "recon_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"entry_id" integer NOT NULL,
	"text" text NOT NULL,
	"gloss" text NOT NULL,
	"entry_state_at_enqueue" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"error_kind" varchar(64),
	"error_message" text,
	"worker_id" text,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recon_jobs" ADD CONSTRAINT "recon_jobs_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recon_jobs_status_idx" ON "recon_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recon_jobs_entry_idx" ON "recon_jobs" USING btree ("entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "recon_jobs_active_per_entry"
  ON "recon_jobs" ("entry_id")
  WHERE "status" IN ('pending', 'running');