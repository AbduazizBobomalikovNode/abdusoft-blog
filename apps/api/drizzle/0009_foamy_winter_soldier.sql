ALTER TABLE "posts" ADD COLUMN "channel_choice" jsonb;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "channel_choice_by" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "channel_choice_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_channel_choice_by_user_id_fk" FOREIGN KEY ("channel_choice_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;