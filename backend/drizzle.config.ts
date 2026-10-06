import type { Config } from "drizzle-kit";
import { DATABASE_URL } from "./src/config-consts";

export default {
  schema: "./src/database/schema.ts",
  out: "./src/database/migrations",
  dialect: "postgresql",
  strict: true,
  verbose: true,
  // "" is fine for `generate`/`check` (no connection); `studio` needs a real DATABASE_URL.
  dbCredentials: { url: DATABASE_URL },
  migrations: { table: "__drizzle_migrations", schema: "drizzle" }
} satisfies Config;
