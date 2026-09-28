CREATE TYPE "public"."channel_message_type" AS ENUM('text', 'photo');--> statement-breakpoint
CREATE TYPE "public"."comment_source" AS ENUM('web', 'telegram');--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "source" "comment_source" DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "tg_chat_id" bigint;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "tg_message_id" bigint;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "tg_username" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "tg_user_id" bigint;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "tg_comments_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_refs" ADD COLUMN "channel_message_type" "channel_message_type";--> statement-breakpoint
ALTER TABLE "telegram_refs" ADD COLUMN "discussion_chat_id" bigint;--> statement-breakpoint
ALTER TABLE "telegram_refs" ADD COLUMN "discussion_message_id" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "comments_tg_chat_message_idx" ON "comments" USING btree ("tg_chat_id","tg_message_id");