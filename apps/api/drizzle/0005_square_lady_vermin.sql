CREATE TYPE "public"."channel_variant" AS ENUM('s', 'm', 'l');--> statement-breakpoint
ALTER TYPE "public"."channel_message_type" ADD VALUE 'album';--> statement-breakpoint
ALTER TABLE "telegram_refs" ADD COLUMN "channel_variant" "channel_variant";--> statement-breakpoint
ALTER TABLE "telegram_refs" ADD COLUMN "channel_message_ids" jsonb;--> statement-breakpoint
ALTER TABLE "telegram_refs" ADD COLUMN "channel_sent_at" timestamp with time zone;