CREATE TABLE IF NOT EXISTS "acd_reconstructions" (
	"pidno" integer PRIMARY KEY NOT NULL,
	"proto_code" text NOT NULL,
	"form" text NOT NULL,
	"form_plain" text NOT NULL,
	"gloss_text" text NOT NULL,
	"set_num" integer NOT NULL,
	"first_letter" varchar(4) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acd_reflexes" (
	"id" serial PRIMARY KEY NOT NULL,
	"pidno" integer NOT NULL,
	"language_name" text NOT NULL,
	"form" text NOT NULL,
	"form_plain" text NOT NULL,
	"gloss_text" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entry_reconstruction_picks" ALTER COLUMN "reconstruction_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "entry_reconstruction_picks" ADD COLUMN "source" varchar(16) DEFAULT 'ai' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "acd_reflexes" ADD CONSTRAINT "acd_reflexes_pidno_acd_reconstructions_pidno_fk" FOREIGN KEY ("pidno") REFERENCES "public"."acd_reconstructions"("pidno") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acd_recon_first_letter_idx" ON "acd_reconstructions" USING btree ("first_letter");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acd_recon_set_num_idx" ON "acd_reconstructions" USING btree ("set_num");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acd_recon_form_plain_idx" ON "acd_reconstructions" USING btree ("form_plain");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acd_reflex_pidno_idx" ON "acd_reflexes" USING btree ("pidno");