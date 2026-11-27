ALTER TABLE "posts" ADD COLUMN "channel_last_error" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "channel_last_error_at" timestamp with time zone;