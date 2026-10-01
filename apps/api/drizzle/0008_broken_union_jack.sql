CREATE TABLE "channel_post_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mode" "channel_mode" NOT NULL,
	"content_json" jsonb NOT NULL,
	"text_html" text DEFAULT '' NOT NULL,
	"visible_length" integer DEFAULT 0 NOT NULL,
	"image_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"base_variant" "channel_variant",
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telegram_refs" ADD COLUMN "channel_version_id" uuid;--> statement-breakpoint
ALTER TABLE "channel_post_versions" ADD CONSTRAINT "channel_post_versions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_post_versions" ADD CONSTRAINT "channel_post_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_post_versions_post_idx" ON "channel_post_versions" USING btree ("post_id");--> statement-breakpoint
ALTER TABLE "telegram_refs" ADD CONSTRAINT "telegram_refs_channel_version_id_channel_post_versions_id_fk" FOREIGN KEY ("channel_version_id") REFERENCES "public"."channel_post_versions"("id") ON DELETE set null ON UPDATE no action;