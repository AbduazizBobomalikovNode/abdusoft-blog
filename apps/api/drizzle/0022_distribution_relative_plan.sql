ALTER TABLE "distributions" ADD COLUMN "plan_delay_minutes" integer;--> statement-breakpoint
ALTER TABLE "distributions" ADD COLUMN "plan_materialized_at" timestamp with time zone;