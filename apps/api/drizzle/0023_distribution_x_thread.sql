ALTER TABLE "distributions" ADD COLUMN "x_thread" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "distributions" ADD COLUMN "x_thread_numbering" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "distributions" ADD COLUMN "thread_ids" jsonb;