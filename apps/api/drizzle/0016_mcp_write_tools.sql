CREATE TABLE "mcp_idempotency" (
	"client_id" text NOT NULL,
	"key" text NOT NULL,
	"tool" text NOT NULL,
	"args_hash" text NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_idempotency_client_id_key_pk" PRIMARY KEY("client_id","key")
);
--> statement-breakpoint
CREATE INDEX "mcp_idempotency_created_idx" ON "mcp_idempotency" USING btree ("created_at");