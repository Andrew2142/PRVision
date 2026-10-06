// CLI wrapper around validateConfig() (`npm run validate:config`). Importing config-consts loads the repo .env.
import { ConfigValidationError, validateConfig } from "../src/config-consts/config-validation";

try {
  validateConfig();
  console.log("PRVision config validation passed.");
} catch (error: unknown) {
  // ConfigValidationError messages name variables and rules only, never secret values.
  console.error(error instanceof ConfigValidationError ? error.message : "Config validation failed unexpectedly.");
  process.exitCode = 1;
}
