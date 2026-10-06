CREATE TABLE "app_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_token_encrypted" text,
	"github_login" varchar(100),
	"ai_provider" text DEFAULT 'anthropic_api' NOT NULL,
	"anthropic_api_key_encrypted" text,
	"ai_model" varchar(100) DEFAULT 'claude-opus-5-5' NOT NULL,
	"ai_harness_effort" text DEFAULT 'high' NOT NULL,
	"ai_summary_effort" text DEFAULT 'medium' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_settings_singleton_check" CHECK ("app_settings"."id" = 1),
	CONSTRAINT "app_settings_ai_provider_check" CHECK ("app_settings"."ai_provider" in ('anthropic_api', 'claude_code')),
	CONSTRAINT "app_settings_ai_harness_effort_check" CHECK ("app_settings"."ai_harness_effort" in ('low', 'medium', 'high', 'xhigh', 'max')),
	CONSTRAINT "app_settings_ai_summary_effort_check" CHECK ("app_settings"."ai_summary_effort" in ('low', 'medium', 'high', 'xhigh', 'max')),
	CONSTRAINT "app_settings_ai_model_check" CHECK (length(trim("app_settings"."ai_model")) > 0)
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"local_path" text NOT NULL,
	"github_owner" varchar(100),
	"github_repo" varchar(100),
	"default_branch" varchar(255) NOT NULL,
	"framework" text DEFAULT 'react_vite' NOT NULL,
	"package_manager" text NOT NULL,
	"vite_config_path" text,
	"tsconfig_path" text,
	"entry_file_path" text,
	"global_style_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_detected_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repositories_framework_check" CHECK ("repositories"."framework" in ('react_vite')),
	CONSTRAINT "repositories_package_manager_check" CHECK ("repositories"."package_manager" in ('npm', 'pnpm', 'yarn')),
	CONSTRAINT "repositories_local_path_absolute_check" CHECK ("repositories"."local_path" like '/%'),
	CONSTRAINT "repositories_name_check" CHECK (length(trim("repositories"."name")) > 0),
	CONSTRAINT "repositories_github_pair_check" CHECK (("repositories"."github_owner" is null) = ("repositories"."github_repo" is null)),
	CONSTRAINT "repositories_global_style_paths_check" CHECK (jsonb_typeof("repositories"."global_style_paths") = 'array')
);
--> statement-breakpoint
CREATE TABLE "visualization_components" (
	"id" serial PRIMARY KEY NOT NULL,
	"visualization_id" integer NOT NULL,
	"file_path" text NOT NULL,
	"export_name" varchar(255) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"change_kind" text NOT NULL,
	"render_status" text DEFAULT 'pending' NOT NULL,
	"visual_change" text,
	"risk" text,
	"rank" integer NOT NULL,
	"change_reason" text,
	"skip_reason" text,
	"harness_source" text,
	"harness_notes" text,
	"mocked_modules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"base_image_path" text,
	"head_image_path" text,
	"diff_image_path" text,
	"image_width" integer,
	"image_height" integer,
	"diff_pixel_ratio" numeric(8, 6),
	"code_diff" text,
	"structural_diff" jsonb,
	"ai_note" text,
	"base_error" text,
	"head_error" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visualization_components_change_kind_check" CHECK ("visualization_components"."change_kind" in ('modified', 'added', 'removed', 'affected_parent')),
	CONSTRAINT "visualization_components_render_status_check" CHECK ("visualization_components"."render_status" in ('pending', 'rendered', 'partial', 'failed', 'skipped')),
	CONSTRAINT "visualization_components_visual_change_check" CHECK ("visualization_components"."visual_change" is null or "visualization_components"."visual_change" in ('changed', 'unchanged', 'new', 'deleted')),
	CONSTRAINT "visualization_components_risk_check" CHECK ("visualization_components"."risk" is null or "visualization_components"."risk" in ('none', 'check', 'likely_regression')),
	CONSTRAINT "visualization_components_rank_check" CHECK ("visualization_components"."rank" >= 0),
	CONSTRAINT "visualization_components_image_size_check" CHECK (("visualization_components"."image_width" is null or "visualization_components"."image_width" > 0) and ("visualization_components"."image_height" is null or "visualization_components"."image_height" > 0)),
	CONSTRAINT "visualization_components_diff_pixel_ratio_check" CHECK ("visualization_components"."diff_pixel_ratio" is null or ("visualization_components"."diff_pixel_ratio" >= 0 and "visualization_components"."diff_pixel_ratio" <= 1)),
	CONSTRAINT "visualization_components_file_path_relative_check" CHECK ("visualization_components"."file_path" not like '/%' and length("visualization_components"."file_path") > 0),
	CONSTRAINT "visualization_components_skip_reason_check" CHECK ("visualization_components"."skip_reason" is null or "visualization_components"."render_status" = 'skipped'),
	CONSTRAINT "visualization_components_image_path_relative_check" CHECK (("visualization_components"."base_image_path" is null or "visualization_components"."base_image_path" like 'artifacts/%')
          and ("visualization_components"."head_image_path" is null or "visualization_components"."head_image_path" like 'artifacts/%')
          and ("visualization_components"."diff_image_path" is null or "visualization_components"."diff_image_path" like 'artifacts/%'))
);
--> statement-breakpoint
CREATE TABLE "visualization_console_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"visualization_id" integer NOT NULL,
	"level" text NOT NULL,
	"stage" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visualization_console_events_level_check" CHECK ("visualization_console_events"."level" in ('info', 'warn', 'error')),
	CONSTRAINT "visualization_console_events_stage_check" CHECK ("visualization_console_events"."stage" in ('queued', 'preparing', 'analyzing', 'generating_harnesses', 'rendering', 'diffing', 'summarizing', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "visualizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository_id" integer NOT NULL,
	"source_type" text NOT NULL,
	"pr_number" integer,
	"title" text NOT NULL,
	"base_ref" varchar(255) NOT NULL,
	"head_ref" varchar(255) NOT NULL,
	"base_sha" varchar(64),
	"head_sha" varchar(64),
	"status" text DEFAULT 'queued' NOT NULL,
	"error_message" text,
	"failed_stage" text,
	"summary_markdown" text,
	"ai_provider" text NOT NULL,
	"ai_model" varchar(100) NOT NULL,
	"ai_usage" jsonb,
	"job_id" varchar(64),
	"component_count" integer DEFAULT 0 NOT NULL,
	"changed_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visualizations_source_type_check" CHECK ("visualizations"."source_type" in ('github_pr', 'local_branch', 'working_tree')),
	CONSTRAINT "visualizations_status_check" CHECK ("visualizations"."status" in ('queued', 'preparing', 'analyzing', 'generating_harnesses', 'rendering', 'diffing', 'summarizing', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "visualizations_ai_provider_check" CHECK ("visualizations"."ai_provider" in ('anthropic_api', 'claude_code')),
	CONSTRAINT "visualizations_pr_number_check" CHECK (("visualizations"."source_type" = 'github_pr' and "visualizations"."pr_number" is not null and "visualizations"."pr_number" > 0)
          or ("visualizations"."source_type" <> 'github_pr' and "visualizations"."pr_number" is null)),
	CONSTRAINT "visualizations_counts_check" CHECK ("visualizations"."component_count" >= 0 and "visualizations"."changed_count" >= 0 and "visualizations"."changed_count" <= "visualizations"."component_count"),
	CONSTRAINT "visualizations_completed_at_check" CHECK ("visualizations"."completed_at" is null or "visualizations"."status" in ('completed', 'failed', 'cancelled')),
	CONSTRAINT "visualizations_failed_stage_check" CHECK ("visualizations"."failed_stage" is null or "visualizations"."failed_stage" in ('queued', 'preparing', 'analyzing', 'generating_harnesses', 'rendering', 'diffing', 'summarizing')),
	CONSTRAINT "visualizations_failed_stage_status_check" CHECK ("visualizations"."failed_stage" is null or "visualizations"."status" in ('failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "visualization_components" ADD CONSTRAINT "visualization_components_visualization_id_visualizations_id_fk" FOREIGN KEY ("visualization_id") REFERENCES "public"."visualizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visualization_console_events" ADD CONSTRAINT "visualization_console_events_visualization_id_visualizations_id_fk" FOREIGN KEY ("visualization_id") REFERENCES "public"."visualizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visualizations" ADD CONSTRAINT "visualizations_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_local_path_active_key" ON "repositories" USING btree ("local_path") WHERE "repositories"."is_deleted" = false;--> statement-breakpoint
CREATE INDEX "repositories_active_created_at_idx" ON "repositories" USING btree ("created_at" DESC NULLS LAST) WHERE "repositories"."is_deleted" = false;--> statement-breakpoint
CREATE INDEX "visualization_components_visualization_id_rank_idx" ON "visualization_components" USING btree ("visualization_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "visualization_components_visualization_file_export_key" ON "visualization_components" USING btree ("visualization_id","file_path","export_name");--> statement-breakpoint
CREATE INDEX "visualization_console_events_visualization_id_id_idx" ON "visualization_console_events" USING btree ("visualization_id","id");--> statement-breakpoint
CREATE INDEX "visualizations_repository_id_created_at_idx" ON "visualizations" USING btree ("repository_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "visualizations_active_created_at_idx" ON "visualizations" USING btree ("created_at" DESC NULLS LAST) WHERE "visualizations"."is_deleted" = false;--> statement-breakpoint
CREATE INDEX "visualizations_non_terminal_status_idx" ON "visualizations" USING btree ("status") WHERE "visualizations"."status" not in ('completed', 'failed', 'cancelled');