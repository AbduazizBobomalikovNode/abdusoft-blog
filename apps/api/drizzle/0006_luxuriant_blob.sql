CREATE TYPE "public"."channel_mode" AS ENUM('media', 'text');--> statement-breakpoint
ALTER TYPE "public"."channel_variant" ADD VALUE 'xl';--> statement-breakpoint
ALTER TABLE "telegram_refs" ADD COLUMN "channel_mode" "channel_mode";