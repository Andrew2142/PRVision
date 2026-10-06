ALTER TABLE "visualization_components" DROP CONSTRAINT "visualization_components_change_kind_check";--> statement-breakpoint
ALTER TABLE "visualization_components" ADD COLUMN "base_file_path" text;--> statement-breakpoint
ALTER TABLE "visualization_components" ADD COLUMN "base_export_name" varchar(255);--> statement-breakpoint
ALTER TABLE "visualization_components" ADD COLUMN "base_display_name" varchar(255);--> statement-breakpoint
ALTER TABLE "visualization_components" ADD COLUMN "base_harness_source" text;--> statement-breakpoint
ALTER TABLE "visualization_components" ADD COLUMN "base_harness_notes" text;--> statement-breakpoint
ALTER TABLE "visualization_components" ADD COLUMN "base_mocked_modules" jsonb;--> statement-breakpoint
ALTER TABLE "visualization_components" ADD COLUMN "successor_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "visualization_components" ADD CONSTRAINT "visualization_components_replaced_columns_check" CHECK (("visualization_components"."change_kind" = 'replaced' and "visualization_components"."base_file_path" is not null and "visualization_components"."base_export_name" is not null
            and "visualization_components"."base_display_name" is not null)
          or ("visualization_components"."change_kind" <> 'replaced' and "visualization_components"."base_file_path" is null and "visualization_components"."base_export_name" is null
            and "visualization_components"."base_display_name" is null and "visualization_components"."base_harness_source" is null and "visualization_components"."base_harness_notes" is null
            and "visualization_components"."base_mocked_modules" is null and "visualization_components"."successor_evidence" is null));--> statement-breakpoint
ALTER TABLE "visualization_components" ADD CONSTRAINT "visualization_components_base_file_path_relative_check" CHECK ("visualization_components"."base_file_path" is null or ("visualization_components"."base_file_path" not like '/%' and length("visualization_components"."base_file_path") > 0));--> statement-breakpoint
ALTER TABLE "visualization_components" ADD CONSTRAINT "visualization_components_change_kind_check" CHECK ("visualization_components"."change_kind" in ('modified', 'added', 'removed', 'affected_parent', 'replaced'));