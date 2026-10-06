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
  VISUALIZATION_CONSOLE_EVENTS: "visualization_console_events"
} as const;
export type Table = ValueOf<typeof Table>;
export const TABLE_VALUES = enumValues(Table);
