ALTER TABLE "user_messages" ADD COLUMN IF NOT EXISTS "encrypted_payload" text;
--> statement-breakpoint
ALTER TABLE "user_messages" ADD COLUMN IF NOT EXISTS "encryption_version" text;
