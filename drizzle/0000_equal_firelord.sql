CREATE TABLE "monitored_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"term" text NOT NULL,
	"term_label" text,
	"course_code" text NOT NULL,
	"course_title" text,
	"class_number" text NOT NULL,
	"component" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "section_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"section_id" uuid NOT NULL,
	"status" text NOT NULL,
	"available_seats" integer,
	"schedule" text,
	"meeting_dates" text,
	"session_name" text,
	"checked_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"baseline_status" text,
	"baseline_available_seats" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"encrypted_data" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_id" bigint NOT NULL,
	"username" text,
	"first_name" text,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_section_id_monitored_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."monitored_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_snapshots" ADD CONSTRAINT "section_snapshots_section_id_monitored_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."monitored_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_section_id_monitored_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."monitored_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "monitored_sections_term_class_idx" ON "monitored_sections" USING btree ("term","class_number");--> statement-breakpoint
CREATE INDEX "monitored_sections_term_course_idx" ON "monitored_sections" USING btree ("term","course_code");--> statement-breakpoint
CREATE INDEX "monitored_sections_class_number_idx" ON "monitored_sections" USING btree ("class_number");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_logs_user_fingerprint_idx" ON "notification_logs" USING btree ("user_id","fingerprint");--> statement-breakpoint
CREATE INDEX "notification_logs_sent_at_idx" ON "notification_logs" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "section_snapshots_section_checked_idx" ON "section_snapshots" USING btree ("section_id","checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_user_section_idx" ON "subscriptions" USING btree ("user_id","section_id");--> statement-breakpoint
CREATE INDEX "subscriptions_user_active_idx" ON "subscriptions" USING btree ("user_id","is_active");--> statement-breakpoint
CREATE INDEX "subscriptions_section_active_idx" ON "subscriptions" USING btree ("section_id","is_active");--> statement-breakpoint
CREATE INDEX "user_sessions_user_id_idx" ON "user_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_sessions_status_idx" ON "user_sessions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "users_telegram_id_idx" ON "users" USING btree ("telegram_id");