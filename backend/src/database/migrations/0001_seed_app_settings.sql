-- Seed the app_settings singleton. Defaults come from the column definitions.
INSERT INTO "app_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
