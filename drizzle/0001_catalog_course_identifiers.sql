ALTER TABLE "monitored_sections" ADD COLUMN IF NOT EXISTS "crse_id" text;
--> statement-breakpoint
ALTER TABLE "monitored_sections" ADD COLUMN IF NOT EXISTS "crse_offer_nbr" text;
--> statement-breakpoint
ALTER TABLE "monitored_sections" ADD COLUMN IF NOT EXISTS "acad_career" text;
--> statement-breakpoint
ALTER TABLE "monitored_sections" ADD COLUMN IF NOT EXISTS "institution" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monitored_sections_term_crse_id_idx" ON "monitored_sections" USING btree ("term", "crse_id");
