CREATE TABLE "harness_library_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository_id" integer NOT NULL,
	"framework" text NOT NULL,
	"file_path" text NOT NULL,
	"export_name" varchar(255) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"selector" varchar(255),
	"source_fingerprint" varchar(64),
	"harness_source" text,
	"mocked_modules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"states" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state_count" integer DEFAULT 0 NOT NULL,
	"state_allowance" integer NOT NULL,
	"status" text NOT NULL,
	"origin" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"last_failed_visualization_id" integer,
	"ai_model" varchar(100),
	"ai_usage" jsonb,
	"cost_usd" numeric(10, 4),
	"written_at" timestamp (3) with time zone,
	"last_rendered_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "harness_library_entries_framework_check" CHECK ("harness_library_entries"."framework" in ('react_vite', 'angular')),
	CONSTRAINT "harness_library_entries_status_check" CHECK ("harness_library_entries"."status" in ('ready', 'needs_update', 'off_default_branch')),
	CONSTRAINT "harness_library_entries_origin_check" CHECK ("harness_library_entries"."origin" in ('run', 'scan', 'repair', 'import')),
	CONSTRAINT "harness_library_entries_file_path_relative_check" CHECK ("harness_library_entries"."file_path" not like '/%' and length("harness_library_entries"."file_path") > 0),
	CONSTRAINT "harness_library_entries_selector_check" CHECK ("harness_library_entries"."framework" = 'angular' or "harness_library_entries"."selector" is null),
	CONSTRAINT "harness_library_entries_source_fingerprint_check" CHECK ("harness_library_entries"."source_fingerprint" is null or "harness_library_entries"."source_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "harness_library_entries_states_check" CHECK (jsonb_typeof("harness_library_entries"."states") = 'array'),
	CONSTRAINT "harness_library_entries_state_count_check" CHECK (("harness_library_entries"."harness_source" is null and "harness_library_entries"."state_count" = 0)
          or ("harness_library_entries"."harness_source" is not null and "harness_library_entries"."state_count" between 1 and 5)),
	CONSTRAINT "harness_library_entries_state_allowance_check" CHECK ("harness_library_entries"."state_allowance" between 1 and 5),
	CONSTRAINT "harness_library_entries_ready_harness_check" CHECK ("harness_library_entries"."status" <> 'ready' or "harness_library_entries"."harness_source" is not null),
	CONSTRAINT "harness_library_entries_revision_check" CHECK ("harness_library_entries"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "harness_library_job_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "harness_library_job_events_level_check" CHECK ("harness_library_job_events"."level" in ('info', 'warn', 'error'))
);
--> statement-breakpoint
CREATE TABLE "harness_library_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository_id" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"visualization_id" integer,
	"component_ids" jsonb,
	"state_allowance" integer NOT NULL,
	"spend_cap_usd" numeric(10, 2),
	"scan_sha" varchar(64),
	"total_count" integer DEFAULT 0 NOT NULL,
	"written_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"current_label" text,
	"spent_usd" numeric(10, 4) DEFAULT 0 NOT NULL,
	"ai_usage" jsonb,
	"ai_model" varchar(100) NOT NULL,
	"job_id" varchar(64),
	"error_message" text,
	"started_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "harness_library_jobs_kind_check" CHECK ("harness_library_jobs"."kind" in ('scan', 'rescan', 'repair')),
	CONSTRAINT "harness_library_jobs_status_check" CHECK ("harness_library_jobs"."status" in ('queued', 'preparing', 'running', 'completed', 'cap_reached', 'failed', 'cancelled')),
	CONSTRAINT "harness_library_jobs_visualization_id_check" CHECK (("harness_library_jobs"."kind" = 'repair') = ("harness_library_jobs"."visualization_id" is not null)),
	CONSTRAINT "harness_library_jobs_component_ids_check" CHECK (("harness_library_jobs"."kind" = 'repair') = ("harness_library_jobs"."component_ids" is not null)),
	CONSTRAINT "harness_library_jobs_state_allowance_check" CHECK ("harness_library_jobs"."state_allowance" between 1 and 5),
	CONSTRAINT "harness_library_jobs_spend_cap_usd_check" CHECK ("harness_library_jobs"."spend_cap_usd" is null or ("harness_library_jobs"."spend_cap_usd" > 0 and "harness_library_jobs"."kind" <> 'repair')),
	CONSTRAINT "harness_library_jobs_counts_check" CHECK ("harness_library_jobs"."total_count" >= 0 and "harness_library_jobs"."written_count" >= 0 and "harness_library_jobs"."failed_count" >= 0
          and "harness_library_jobs"."skipped_count" >= 0
          and "harness_library_jobs"."written_count" + "harness_library_jobs"."failed_count" + "harness_library_jobs"."skipped_count" <= "harness_library_jobs"."total_count"),
	CONSTRAINT "harness_library_jobs_completed_at_check" CHECK ("harness_library_jobs"."completed_at" is null or "harness_library_jobs"."status" in ('completed', 'cap_reached', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "live_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"visualization_id" integer NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"job_id" varchar(64),
	"hosts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"open_requests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"open_requests_version" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"stop_reason" text,
	"last_heartbeat_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp (3) with time zone,
	"stopped_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_sessions_status_check" CHECK ("live_sessions"."status" in ('starting', 'ready', 'stopping', 'stopped', 'failed')),
	CONSTRAINT "live_sessions_stop_reason_check" CHECK ("live_sessions"."stop_reason" is null or "live_sessions"."stop_reason" in ('user', 'left', 'idle', 'max_duration', 'shutdown', 'error')),
	CONSTRAINT "live_sessions_stop_reason_status_check" CHECK ("live_sessions"."stop_reason" is null or "live_sessions"."status" in ('stopping', 'stopped', 'failed')),
	CONSTRAINT "live_sessions_open_requests_version_check" CHECK ("live_sessions"."open_requests_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "visualization_component_states" (
	"id" serial PRIMARY KEY NOT NULL,
	"visualization_component_id" integer NOT NULL,
	"visualization_id" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"state_name" varchar(40) NOT NULL,
	"on_base" boolean NOT NULL,
	"on_head" boolean NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"render_status" text DEFAULT 'pending' NOT NULL,
	"visual_change" text,
	"base_image_path" text,
	"head_image_path" text,
	"diff_image_path" text,
	"image_width" integer,
	"image_height" integer,
	"diff_pixel_ratio" numeric(8, 6),
	"base_error" text,
	"head_error" text,
	"base_failure_kind" text,
	"head_failure_kind" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visualization_component_states_ordinal_check" CHECK ("visualization_component_states"."ordinal" between 0 and 9),
	CONSTRAINT "visualization_component_states_default_ordinal_check" CHECK ("visualization_component_states"."ordinal" <> 0 or "visualization_component_states"."state_name" = 'Default'),
	CONSTRAINT "visualization_component_states_sides_check" CHECK ("visualization_component_states"."on_base" or "visualization_component_states"."on_head"),
	CONSTRAINT "visualization_component_states_render_status_check" CHECK ("visualization_component_states"."render_status" in ('pending', 'rendered', 'partial', 'failed', 'skipped')),
	CONSTRAINT "visualization_component_states_visual_change_check" CHECK ("visualization_component_states"."visual_change" is null or "visualization_component_states"."visual_change" in ('changed', 'unchanged', 'new', 'deleted')),
	CONSTRAINT "visualization_component_states_image_path_relative_check" CHECK (("visualization_component_states"."base_image_path" is null or "visualization_component_states"."base_image_path" like 'artifacts/%')
          and ("visualization_component_states"."head_image_path" is null or "visualization_component_states"."head_image_path" like 'artifacts/%')
          and ("visualization_component_states"."diff_image_path" is null or "visualization_component_states"."diff_image_path" like 'artifacts/%')),
	CONSTRAINT "visualization_component_states_image_size_check" CHECK (("visualization_component_states"."image_width" is null or "visualization_component_states"."image_width" > 0) and ("visualization_component_states"."image_height" is null or "visualization_component_states"."image_height" > 0)),
	CONSTRAINT "visualization_component_states_diff_pixel_ratio_check" CHECK ("visualization_component_states"."diff_pixel_ratio" is null or ("visualization_component_states"."diff_pixel_ratio" >= 0 and "visualization_component_states"."diff_pixel_ratio" <= 1)),
	CONSTRAINT "visualization_component_states_base_failure_kind_check" CHECK ("visualization_component_states"."base_failure_kind" is null or "visualization_component_states"."base_failure_kind" in ('vite_unavailable', 'navigation', 'module_load', 'render_error', 'timeout', 'step_failed', 'browser', 'screenshot', 'file_missing', 'budget_exceeded', 'cancelled')),
	CONSTRAINT "visualization_component_states_head_failure_kind_check" CHECK ("visualization_component_states"."head_failure_kind" is null or "visualization_component_states"."head_failure_kind" in ('vite_unavailable', 'navigation', 'module_load', 'render_error', 'timeout', 'step_failed', 'browser', 'screenshot', 'file_missing', 'budget_exceeded', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "visualization_components" DROP CONSTRAINT "visualization_components_change_kind_check";--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "library_build_mode" text DEFAULT 'grow' NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "state_allowance" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "visualization_components" ADD COLUMN "library_entry_id" integer;--> statement-breakpoint
ALTER TABLE "visualization_components" ADD COLUMN "base_library_entry_id" integer;--> statement-breakpoint
ALTER TABLE "visualization_components" ADD COLUMN "harness_origin" text;--> statement-breakpoint
ALTER TABLE "visualization_components" ADD COLUMN "base_harness_origin" text;--> statement-breakpoint
ALTER TABLE "visualization_components" ADD COLUMN "harness_needs_update" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "visualization_components" ADD COLUMN "source_changed_since_write" boolean;--> statement-breakpoint
ALTER TABLE "visualization_components" ADD COLUMN "state_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "visualization_components" ADD COLUMN "changed_state_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "visualizations" ADD COLUMN "checked_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "visualizations" ADD COLUMN "reused_harness_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "visualizations" ADD COLUMN "new_harness_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "visualizations" ADD COLUMN "needs_update_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "visualizations" ADD COLUMN "global_style_trigger" text;--> statement-breakpoint
ALTER TABLE "visualizations" ADD COLUMN "working_tree_snapshot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "harness_library_entries" ADD CONSTRAINT "harness_library_entries_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_library_job_events" ADD CONSTRAINT "harness_library_job_events_job_id_harness_library_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."harness_library_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_library_jobs" ADD CONSTRAINT "harness_library_jobs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_library_jobs" ADD CONSTRAINT "harness_library_jobs_visualization_id_visualizations_id_fk" FOREIGN KEY ("visualization_id") REFERENCES "public"."visualizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_visualization_id_visualizations_id_fk" FOREIGN KEY ("visualization_id") REFERENCES "public"."visualizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visualization_component_states" ADD CONSTRAINT "visualization_component_states_visualization_component_id_visualization_components_id_fk" FOREIGN KEY ("visualization_component_id") REFERENCES "public"."visualization_components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visualization_component_states" ADD CONSTRAINT "visualization_component_states_visualization_id_visualizations_id_fk" FOREIGN KEY ("visualization_id") REFERENCES "public"."visualizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "harness_library_entries_identity_key" ON "harness_library_entries" USING btree ("repository_id","file_path","export_name");--> statement-breakpoint
CREATE INDEX "harness_library_entries_repository_status_idx" ON "harness_library_entries" USING btree ("repository_id","status");--> statement-breakpoint
CREATE INDEX "harness_library_job_events_job_id_id_idx" ON "harness_library_job_events" USING btree ("job_id","id");--> statement-breakpoint
CREATE INDEX "harness_library_jobs_repository_created_idx" ON "harness_library_jobs" USING btree ("repository_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "harness_library_jobs_active_scan_key" ON "harness_library_jobs" USING btree ("repository_id") WHERE "harness_library_jobs"."kind" in ('scan', 'rescan') and "harness_library_jobs"."status" in ('queued', 'preparing', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "harness_library_jobs_active_repair_key" ON "harness_library_jobs" USING btree ("visualization_id") WHERE "harness_library_jobs"."kind" = 'repair' and "harness_library_jobs"."status" in ('queued', 'preparing', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "live_sessions_active_visualization_key" ON "live_sessions" USING btree ("visualization_id") WHERE "live_sessions"."status" in ('starting', 'ready', 'stopping');--> statement-breakpoint
CREATE INDEX "live_sessions_active_idx" ON "live_sessions" USING btree ("status") WHERE "live_sessions"."status" in ('starting', 'ready', 'stopping');--> statement-breakpoint
CREATE UNIQUE INDEX "visualization_component_states_component_ordinal_key" ON "visualization_component_states" USING btree ("visualization_component_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "visualization_component_states_component_name_key" ON "visualization_component_states" USING btree ("visualization_component_id","state_name");--> statement-breakpoint
CREATE INDEX "visualization_component_states_visualization_idx" ON "visualization_component_states" USING btree ("visualization_id");--> statement-breakpoint
ALTER TABLE "visualization_components" ADD CONSTRAINT "visualization_components_library_entry_id_harness_library_entries_id_fk" FOREIGN KEY ("library_entry_id") REFERENCES "public"."harness_library_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visualization_components" ADD CONSTRAINT "visualization_components_base_library_entry_id_harness_library_entries_id_fk" FOREIGN KEY ("base_library_entry_id") REFERENCES "public"."harness_library_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_library_build_mode_check" CHECK ("repositories"."library_build_mode" in ('grow', 'scan'));--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_state_allowance_check" CHECK ("repositories"."state_allowance" between 1 and 5);--> statement-breakpoint
ALTER TABLE "visualization_components" ADD CONSTRAINT "visualization_components_base_library_entry_id_check" CHECK ("visualization_components"."change_kind" = 'replaced' or "visualization_components"."base_library_entry_id" is null);--> statement-breakpoint
ALTER TABLE "visualization_components" ADD CONSTRAINT "visualization_components_harness_origin_check" CHECK ("visualization_components"."harness_origin" is null or "visualization_components"."harness_origin" in ('library', 'written', 'repaired'));--> statement-breakpoint
ALTER TABLE "visualization_components" ADD CONSTRAINT "visualization_components_base_harness_origin_check" CHECK (("visualization_components"."base_harness_origin" is null or "visualization_components"."base_harness_origin" in ('library', 'written', 'repaired'))
          and ("visualization_components"."change_kind" = 'replaced' or "visualization_components"."base_harness_origin" is null));--> statement-breakpoint
ALTER TABLE "visualization_components" ADD CONSTRAINT "visualization_components_changed_state_count_check" CHECK ("visualization_components"."changed_state_count" >= 0 and "visualization_components"."changed_state_count" <= "visualization_components"."state_count");--> statement-breakpoint
ALTER TABLE "visualization_components" ADD CONSTRAINT "visualization_components_change_kind_check" CHECK ("visualization_components"."change_kind" in ('modified', 'added', 'removed', 'affected_parent', 'replaced', 'rechecked'));--> statement-breakpoint
ALTER TABLE "visualizations" ADD CONSTRAINT "visualizations_checked_count_check" CHECK ("visualizations"."checked_count" >= 0 and "visualizations"."checked_count" <= "visualizations"."component_count");--> statement-breakpoint
ALTER TABLE "visualizations" ADD CONSTRAINT "visualizations_working_tree_snapshot_check" CHECK (not "visualizations"."working_tree_snapshot" or "visualizations"."source_type" = 'working_tree');