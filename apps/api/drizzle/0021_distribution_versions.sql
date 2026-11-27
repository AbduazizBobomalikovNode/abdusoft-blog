CREATE TABLE "distribution_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"image_choice" text DEFAULT 'auto' NOT NULL,
	"link_mode" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_via" text DEFAULT 'web' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "distributions" ADD COLUMN "version_id" uuid;--> statement-breakpoint
ALTER TABLE "distribution_versions" ADD CONSTRAINT "distribution_versions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_versions" ADD CONSTRAINT "distribution_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "distribution_versions_post_provider_idx" ON "distribution_versions" USING btree ("post_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "distribution_versions_primary_idx" ON "distribution_versions" USING btree ("post_id","provider") WHERE "distribution_versions"."is_primary";--> statement-breakpoint
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_version_id_distribution_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."distribution_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
INSERT INTO "distribution_versions" ("post_id", "provider", "name", "text", "image_choice", "link_mode", "is_primary", "created_by", "created_via")
SELECT "post_id", "provider", '1-versiya', "text", "image_choice", "link_mode", true, "created_by", 'web'
FROM "distributions"
WHERE "status" IN ('draft', 'scheduled', 'sending', 'failed', 'needs_checking')
  AND "provider" <> 'github'
  AND "text" IS NOT NULL
  AND btrim("text") <> '';
