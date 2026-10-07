import { enumValues, type ValueOf } from "./value-of";

/**
 * Logical table identifiers. Values are the SQL table names (00 §5, §14.3). QueryHandlerDrizzle resolves them
 * through database/table-registry.ts, never by schema export name.
 */
export const Table = {
  APP_SETTINGS: "app_settings",
  REPOSITORIES: "repositories",
  VISUALIZATIONS: "visualizations",
  VISUALIZATION_COMPONENTS: "visualization_components",
  VISUALIZATION_CONSOLE_EVENTS: "visualization_console_events",
  HARNESS_LIBRARY_ENTRIES: "harness_library_entries",
  HARNESS_LIBRARY_JOBS: "harness_library_jobs",
  HARNESS_LIBRARY_JOB_EVENTS: "harness_library_job_events",
  VISUALIZATION_COMPONENT_STATES: "visualization_component_states",
  LIVE_SESSIONS: "live_sessions"
} as const;
export type Table = ValueOf<typeof Table>;
export const TABLE_VALUES = enumValues(Table);
