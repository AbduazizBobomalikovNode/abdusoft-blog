CREATE TYPE "public"."distribution_status" AS ENUM('draft', 'scheduled', 'sending', 'sent', 'failed', 'needs_checking', 'cancelled');--> statement-breakpoint
CREATE TABLE "distribution_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text NOT NULL,
	"username" text,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"refresh_ambiguous_at" timestamp with time zone,
	"last_refresh_at" timestamp with time zone,
	"last_reminder_at" timestamp with time zone,
	"issued_at" timestamp with time zone NOT NULL,
	"connected_at" timestamp with time zone NOT NULL,
	"connected_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "distribution_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_url" text NOT NULL,
	"fingerprint" text NOT NULL,
	"storage_key" text NOT NULL,
	"url" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "distribution_oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"code_verifier_enc" text,
	"created_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "distributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"account_id" uuid,
	"status" "distribution_status" DEFAULT 'draft' NOT NULL,
	"text" text,
	"sent_text" text,
	"image_choice" text DEFAULT 'auto' NOT NULL,
	"link_mode" text,
	"scheduled_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_kind" text,
	"last_error_message" text,
	"external_id" text,
	"external_url" text,
	"step" text,
	"partial" jsonb,
	"created_by" text,
	"created_via" text DEFAULT 'web' NOT NULL,
	"sent_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "distribution_accounts" ADD CONSTRAINT "distribution_accounts_connected_by_user_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_images" ADD CONSTRAINT "distribution_images_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_oauth_states" ADD CONSTRAINT "distribution_oauth_states_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_account_id_distribution_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."distribution_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "distribution_accounts_provider_external_idx" ON "distribution_accounts" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "distribution_accounts_provider_idx" ON "distribution_accounts" USING btree ("provider");--> statement-breakpoint
CREATE UNIQUE INDEX "distribution_images_post_fp_idx" ON "distribution_images" USING btree ("post_id","fingerprint");--> statement-breakpoint
CREATE INDEX "distribution_oauth_states_expires_idx" ON "distribution_oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "distributions_active_post_provider_idx" ON "distributions" USING btree ("post_id","provider") WHERE "distributions"."status" in ('draft', 'scheduled', 'sending', 'failed', 'needs_checking');--> statement-breakpoint
CREATE INDEX "distributions_due_idx" ON "distributions" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "distributions_post_idx" ON "distributions" USING btree ("post_id");