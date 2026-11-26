CREATE TYPE "public"."motion_job_kind" AS ENUM('preview', 'render', 'gif');--> statement-breakpoint
CREATE TYPE "public"."motion_job_status" AS ENUM('queued', 'running', 'ready', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "motion_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"url" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"seconds" real,
	"scene_index" integer,
	"scene_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "motion_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "motion_job_kind" NOT NULL,
	"status" "motion_job_status" DEFAULT 'queued' NOT NULL,
	"post_id" uuid,
	"storyboard" jsonb NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"duration_seconds" real NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"phase" text,
	"message" text,
	"error_code" text,
	"error_message" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"worker_pid" integer,
	"runner" text,
	"runner_run_id" text,
	"runner_attempt" integer,
	"runner_dispatched_at" timestamp with time zone,
	"runner_claimed_at" timestamp with time zone,
	"dispatch_attempts" integer DEFAULT 0 NOT NULL,
	"dispatch_after" timestamp with time zone,
	"requested_by" text,
	"via" text NOT NULL,
	"client_name" text,
	"timings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "motion_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "motion_assets" ADD CONSTRAINT "motion_assets_job_id_motion_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."motion_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motion_jobs" ADD CONSTRAINT "motion_jobs_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motion_jobs" ADD CONSTRAINT "motion_jobs_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "motion_assets_job_idx" ON "motion_assets" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "motion_jobs_status_created_idx" ON "motion_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "motion_jobs_post_created_idx" ON "motion_jobs" USING btree ("post_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "motion_jobs_one_active_per_post_idx" ON "motion_jobs" USING btree ("post_id") WHERE "motion_jobs"."post_id" is not null and "motion_jobs"."kind" in ('render', 'gif') and "motion_jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "motion_usage_bucket_created_idx" ON "motion_usage" USING btree ("bucket","created_at");