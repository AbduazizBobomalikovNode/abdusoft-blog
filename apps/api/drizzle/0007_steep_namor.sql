ALTER TABLE "posts" ADD COLUMN "channel_plan" jsonb;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "channel_send_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "posts_channel_send_at_idx" ON "posts" USING btree ("channel_send_at");