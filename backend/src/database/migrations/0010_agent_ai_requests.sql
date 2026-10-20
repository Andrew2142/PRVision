CREATE TABLE "agent_ai_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"visualization_id" integer NOT NULL,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"system_prompt" text NOT NULL,
	"prompt" text NOT NULL,
	"json_schema" jsonb NOT NULL,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"response" jsonb,
	"error_message" text,
	"claimed_at" timestamp (3) with time zone,
	"answered_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_ai_requests_purpose_check" CHECK ("agent_ai_requests"."purpose" in ('harness', 'harness_repair', 'summary')),
	CONSTRAINT "agent_ai_requests_status_check" CHECK ("agent_ai_requests"."status" in ('pending', 'claimed', 'answered', 'failed', 'cancelled')),
	CONSTRAINT "agent_ai_requests_answered_check" CHECK (("agent_ai_requests"."status" = 'answered') = ("agent_ai_requests"."answered_at" is not null and "agent_ai_requests"."response" is not null))
);
--> statement-breakpoint
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_ai_provider_check";--> statement-breakpoint
ALTER TABLE "visualizations" DROP CONSTRAINT "visualizations_ai_provider_check";--> statement-breakpoint
ALTER TABLE "agent_ai_requests" ADD CONSTRAINT "agent_ai_requests_visualization_id_visualizations_id_fk" FOREIGN KEY ("visualization_id") REFERENCES "public"."visualizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_ai_requests_visualization_id_status_id_idx" ON "agent_ai_requests" USING btree ("visualization_id","status","id");--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_ai_provider_check" CHECK ("app_settings"."ai_provider" in ('anthropic_api', 'claude_code', 'agent'));--> statement-breakpoint
ALTER TABLE "visualizations" ADD CONSTRAINT "visualizations_ai_provider_check" CHECK ("visualizations"."ai_provider" in ('anthropic_api', 'claude_code', 'agent'));