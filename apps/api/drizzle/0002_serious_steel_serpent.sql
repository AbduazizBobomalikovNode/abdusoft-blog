CREATE TABLE "banned_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_hash" text,
	"ip_hash" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "banned_devices_device_idx" ON "banned_devices" USING btree ("device_hash");--> statement-breakpoint
CREATE INDEX "banned_devices_ip_idx" ON "banned_devices" USING btree ("ip_hash");