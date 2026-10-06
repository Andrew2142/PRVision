ALTER TABLE "repositories" DROP CONSTRAINT "repositories_framework_check";--> statement-breakpoint
DROP INDEX "repositories_local_path_active_key";--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "app_root" text DEFAULT '.' NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "angular_project" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "angular_build_configuration" text;--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_local_path_app_active_key" ON "repositories" USING btree ("local_path","app_root",coalesce("angular_project", '')) WHERE "repositories"."is_deleted" = false;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_app_root_check" CHECK ("repositories"."app_root" = '.' or ("repositories"."app_root" !~ '^/' and "repositories"."app_root" !~ '(^|/)\.\.?(/|$)' and "repositories"."app_root" !~ '/$' and "repositories"."app_root" !~ '\\'));--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_angular_project_check" CHECK (("repositories"."framework" = 'angular') = ("repositories"."angular_project" is not null));--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_react_root_check" CHECK ("repositories"."framework" <> 'react_vite' or "repositories"."app_root" = '.');--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_framework_check" CHECK ("repositories"."framework" in ('react_vite', 'angular'));