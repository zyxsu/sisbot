CREATE TABLE IF NOT EXISTS "user_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"telegram_message_id" bigint NOT NULL,
	"telegram_update_id" bigint NOT NULL,
	"chat_id" bigint NOT NULL,
	"message_type" text NOT NULL,
	"text" text,
	"caption" text,
	"metadata" jsonb,
	"encrypted_payload" text,
	"encryption_version" text,
	"sent_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_messages" ADD CONSTRAINT "user_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_messages_chat_message_idx" ON "user_messages" USING btree ("chat_id", "telegram_message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_messages_user_sent_idx" ON "user_messages" USING btree ("user_id", "sent_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_messages_type_idx" ON "user_messages" USING btree ("message_type");
