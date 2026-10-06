// ESLint flat config for the PRVision backend, its scripts and tests/backend.
// Run through `npm run lint` in backend/, which lints from the repo root so
// tests/backend/** is inside ESLint's base path. Spec: docs/specs/01-engineering-standards.md §5.3.
const path = require("node:path");
const { defineConfig } = require("eslint/config");
const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const globals = require("globals");
const importX = require("eslint-plugin-import-x");
const { createTypeScriptImportResolver } = require("eslint-import-resolver-typescript");
const eslintComments = require("@eslint-community/eslint-plugin-eslint-comments/configs");

const backendDir = __dirname;
const repoRoot = path.resolve(backendDir, "..");
const tsconfigPath = path.join(backendDir, "tsconfig.eslint.json");

function rel(target) {
  const relative = path.relative(process.cwd(), target).split(path.sep).join("/");
  return relative === "" ? "." : relative;
}
const backend = rel(backendDir);
const src = `${backend}/src`;
const tests = rel(path.join(repoRoot, "tests/backend"));

// child_process: only execFile/spawn (argument arrays). Applied in every block
// because a later no-restricted-imports entry replaces an earlier one.
const childProcessBans = ["child_process", "node:child_process"].map((name) => ({
  name,
  importNames: ["exec", "execSync"],
  message: "Use execFile/spawn with an argument array via utilities/helpers/process.ts (01 §5.9)."
}));
const ban = {
  drizzleOrm: { regex: "^drizzle-orm(/.*)?$", message: "Controllers must not use Drizzle; call a service." },
  pg: { regex: "^pg(/.*)?$", message: "Controllers must not use pg; call a service." },
  database: { regex: "(^|/)database(/|$)", message: "Persistence belongs in services, not this layer." },
  drizzleDb: { regex: "(^|/)drizzle-db$", message: "Persistence belongs in services, not this layer." },
  express: { regex: "^express(/.*)?$", message: "HTTP transport (express) belongs in controllers/routes/middleware." },
  services: { regex: "(^|/)services(/|$)", message: "This layer must not depend on services." },
  utilityServices: {
    regex: "(^|/)utilities/services(/|$)",
    message: "DTOs must not depend on infrastructure services."
  },
  controllers: { regex: "(^|/)controllers(/|$)", message: "Services must not depend on controllers." }
};
function restrictImports(...entries) {
  return ["error", { paths: childProcessBans, patterns: entries.map(({ regex, message }) => ({ regex, message })) }];
}

const sqlRawBan = {
  selector: "MemberExpression[object.name='sql'][property.name='raw']",
  message: "sql.raw is banned; use parameterised sql`` templates."
};
const shellTrueBan = {
  selector: "Property[key.name='shell'][value.value=true]",
  message: "shell: true is banned; pass an argument array to execFile/spawn."
};
const rawResponseBans = [
  {
    selector: "CallExpression[callee.object.name='res'][callee.property.name=/^(json|send)$/]",
    message: "Return responses through ResponseHandler, not res.json/res.send."
  },
  {
    selector:
      "CallExpression[callee.property.name=/^(json|send)$/][callee.object.type='CallExpression'][callee.object.callee.object.name='res']",
    message: "Return responses through ResponseHandler, not res.status(...).json/send."
  }
];

module.exports = defineConfig(
  {
    ignores: [
      `${backend}/dist/**`,
      `${backend}/node_modules/**`,
      `${backend}/harness-templates/**`,
      `${src}/database/migrations/**`,
      `${src}/models/**`
    ]
  },
  {
    linterOptions: { reportUnusedDisableDirectives: "error", reportUnusedInlineConfigs: "error" }
  },

  // ---- TypeScript: src, tests, scripts (typed, strict) ----
  {
    files: [`${src}/**/*.ts`, `${tests}/**/*.ts`, `${backend}/scripts/**/*.ts`, `${backend}/drizzle.config.ts`],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked, eslintComments.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: globals.node,
      parserOptions: { project: [tsconfigPath], tsconfigRootDir: backendDir }
    },
    plugins: { "import-x": importX },
    settings: {
      "import-x/extensions": importX.flatConfigs.typescript.settings["import-x/extensions"],
      "import-x/external-module-folders": importX.flatConfigs.typescript.settings["import-x/external-module-folders"],
      "import-x/parsers": importX.flatConfigs.typescript.settings["import-x/parsers"],
      "import-x/resolver-next": [createTypeScriptImportResolver({ project: tsconfigPath })]
    },
    rules: {
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false }],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "separate-type-imports" }],
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
      "@typescript-eslint/no-extraneous-class": ["error", { allowStaticOnly: true }],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true, allowBoolean: true }],
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }
      ],
      "require-await": "off",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
      eqeqeq: ["error", "always"],
      curly: ["error", "all"],
      "no-console": "error",
      "no-restricted-imports": restrictImports(),
      "no-restricted-syntax": ["error", sqlRawBan, shellTrueBan, ...rawResponseBans],
      "import-x/no-cycle": ["error", { ignoreExternal: true }],
      "import-x/no-duplicates": "error",
      "@eslint-community/eslint-comments/require-description": ["error", { ignore: [] }],
      "@eslint-community/eslint-comments/no-unlimited-disable": "error",
      "@eslint-community/eslint-comments/disable-enable-pair": ["error", { allowWholeFile: true }]
    }
  },

  // ---- Architecture: layer import boundaries (ARCHITECTURE_GUIDELINES §4, §14) ----
  {
    files: [`${src}/controllers/**/*.ts`],
    rules: { "no-restricted-imports": restrictImports(ban.drizzleOrm, ban.pg, ban.database, ban.drizzleDb) }
  },
  {
    files: [`${src}/services/**/*.ts`, `${src}/utilities/**/*.ts`],
    ignores: [`${src}/utilities/context/**`, `${src}/utilities/handlers/response-handler.ts`],
    rules: { "no-restricted-imports": restrictImports(ban.express, ban.controllers) }
  },
  {
    files: [`${src}/dtos/**/*.ts`],
    rules: { "no-restricted-imports": restrictImports(ban.services, ban.database, ban.utilityServices) }
  },
  {
    files: [`${src}/utilities/handlers/response-handler.ts`],
    rules: { "no-restricted-syntax": ["error", sqlRawBan, shellTrueBan] }
  },
  {
    // CHECK constraints need inlined literals: drizzle-kit does not inline bound
    // parameters in DDL (01 §5.11). sql.raw is allowed here and nowhere else.
    files: [`${src}/database/schema.ts`],
    rules: { "no-restricted-syntax": ["error", shellTrueBan, ...rawResponseBans] }
  },

  // ---- Console output is the interface ----
  {
    files: [`${src}/utilities/loggers/**/*.ts`, `${backend}/scripts/**`],
    rules: { "no-console": "off" }
  },

  // ---- Tests: relaxed unsafe-* and console; floating test() promises allowed ----
  {
    files: [`${tests}/**/*.ts`],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            {
              from: "package",
              package: "node:test",
              name: ["test", "it", "describe", "suite", "before", "after", "beforeEach", "afterEach"]
            }
          ]
        }
      ],
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off"
    }
  },

  // ---- Plain JS scripts and this file (untyped) ----
  {
    files: [`${backend}/scripts/**/*.mjs`, `${backend}/eslint.config.js`],
    extends: [js.configs.recommended, eslintComments.recommended],
    languageOptions: { ecmaVersion: 2023, globals: globals.node },
    rules: {
      eqeqeq: ["error", "always"],
      "@eslint-community/eslint-comments/require-description": ["error", { ignore: [] }],
      "@eslint-community/eslint-comments/no-unlimited-disable": "error"
    }
  },
  { files: [`${backend}/eslint.config.js`], languageOptions: { sourceType: "commonjs" } }
);
