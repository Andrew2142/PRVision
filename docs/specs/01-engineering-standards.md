# 01 — Engineering Standards (Node, TypeScript, Express, Drizzle, Angular)

Owner: build agents (reference sheet; no feature code)
Status: binding for every sheet 02–14. Where this sheet and `docs/ARCHITECTURE_GUIDELINES.md` disagree, the guidelines win on *architecture shape* (layers, thin controllers, `QueryHandler`, `ResponseHandler`, `AuthContext`, BullMQ) and this sheet wins on *code quality mechanics* (compiler flags, lint rules, logging, child processes, Angular idioms). Contracts (names, paths, enums, tables, types, routes) come from `00-overview-and-contracts.md` — including **§14 (Revision 2), which overrides earlier 00 sections** — and are never changed here except through §11.

---

## 1. Purpose

Give every build agent one concrete, checkable definition of "written the PRVision way":

- the exact compiler, lint and format configuration (copy-paste ready, verified against the real package versions on 2026-10-03),
- naming, folder and barrel rules aligned with `ARCHITECTURE_GUIDELINES.md` §11,
- one error model for HTTP services (`ApiResponse`), pipeline steps (`PipelineStepError`) and AI providers (`AiProviderError`),
- logging, async, child-process, Drizzle, Express, queue, Angular and testing rules,
- commit conventions and a Definition of Done that every sheet's acceptance list builds on.

PRVision keeps Uply-v2's architecture and visual design. It deliberately tightens the mechanics (strict typed lint, pino, OnPush, signals, typed validation tuples). Every such change is listed in §5.1 so an agent copying a Uply file knows what to adjust.

## 2. Scope / Out of scope

In scope:

- Backend: TypeScript config, ESLint/Prettier config, naming, layering, error/log/async/child-process rules, configuration access, Drizzle/Postgres practice, Express 5 practice, BullMQ worker practice, `node:test` practice.
- Frontend: Angular 19 component/service/form/RxJS/signal rules, folder structure, accessibility, styling parity with Uply-v2.
- Git and commit conventions, Definition of Done.

Out of scope (owned elsewhere):

- Creating the config files on disk, package versions, scripts, docker, env: sheet 02 (it copies the configs in this sheet verbatim).
- Implementing `ResponseHandler`, `Validation`, `QueryHandler`, `logger`, `runProcess`, `AuthContext`: sheet 04 (this sheet fixes their required behaviour and signatures).
- Schema contents and the model generator output: sheet 03.
- The Uply-parity component inventory and `styles.scss`: sheet 12.
- Fixture repo, e2e and QA flows: sheet 14.

## 3. Dependencies

- `00-overview-and-contracts.md`: §4 (paths, ports, env), §5 (enums), §6 (tables), §7 (module map), §8 (pipeline types incl. `AiProviderError`), §9 (routes, view shapes), §10 (queue), §12 (frontend contracts), and §14 (Revision 2: runtime, wire envelope and complete `error_reason` list, `Table`/registry, API shapes, local security, queue processor, `PipelineStepError`, infrastructure APIs, testing contracts).
- `docs/ARCHITECTURE_GUIDELINES.md` (binding architecture style).
- Uply-v2 donor files read for this sheet (all paths under `~/dev/Uply-v2`):
  `backend/tsconfig.json`, `backend/tsconfig.eslint.json`, `backend/eslint.config.js`, `backend/.prettierrc.json`, `backend/.prettierignore`, `backend/package.json`, `backend/scripts/check-architecture.mjs`, `backend/scripts/generate-models.ts`, `backend/src/app.ts`, `backend/src/worker.ts`, `backend/src/routes/index.ts`, `backend/src/controllers/monitors/monitor-tags-controller.ts`, `backend/src/services/monitors/monitor-tags-service.ts`, `backend/src/utilities/handlers/{response-handler,query-handler,query-handler-drizzle}.ts`, `backend/src/utilities/validation/validation.ts`, `backend/src/utilities/mappers/dto-mapper.ts`, `backend/src/utilities/context/auth-context.ts`, `backend/src/utilities/helpers/{env,error-message,runtime-connection-config}.ts`, `backend/src/config-consts/*.ts`, `backend/src/enums/**`, `backend/src/database/schema.ts`, `tests/backend/helpers/test-context.ts`, `tests/backend/monitor-tags.test.ts`, `docs/BACKEND_HARDENING_PLAN.md` §3, `tenant-frontend/{angular.json,tsconfig*.json,eslint.config.mjs,.editorconfig}`, `tenant-frontend/src/app/{app.config.ts,app.component.ts,app.routes.ts}`, `tenant-frontend/src/app/core/{services,interceptors}/*.ts`, `tenant-frontend/src/app/shared/components/status-pill/status-pill.component.ts`, `tenant-frontend/src/styles.scss`.

## 4. File inventory

This sheet creates no source files. It defines content that other sheets place on disk:

| File (PRVision repo) | Content source | Created by |
|---|---|---|
| `backend/tsconfig.json`, `backend/tsconfig.eslint.json` | §5.2.1 | 02 |
| `frontend/tsconfig.json`, `frontend/tsconfig.app.json`, `frontend/tsconfig.spec.json` | §5.2.2 | 02 |
| `backend/eslint.config.js` | §5.3.1 | 02 |
| `frontend/eslint.config.mjs` | §5.3.2 | 02 |
| `backend/.prettierrc.json`, `backend/.prettierignore`, `frontend/.prettierrc.json`, `frontend/.prettierignore`, `.editorconfig` | §5.4 | 02 |
| `backend/scripts/check-architecture.mjs` | rules in §5.6.4, full file in 02 §6.9 | 02 |
| `backend/src/types/pipeline-errors.ts` | §5.7.3 (exact code; 04 §10 is identical) | 02 (scaffold), owned by 04 |
| `backend/src/utilities/loggers/logger.ts` | behaviour in §5.8, code in 04 §9.10 | 04 |
| `backend/src/utilities/helpers/process.ts` | signature in §5.9.3, algorithm in 04 §9.6 | 04 |
| `backend/src/utilities/validation/validation.ts` | typed tuple in §5.7.1 | 04 |
| `CLAUDE.md` (repo root, agent rules) | §5.17 + §5.16 | 02 |

## 5. Detailed design

### 5.1 Toolchain baseline and deliberate improvements over Uply-v2

| Area | Uply-v2 today (read from source) | PRVision standard | Why / compatibility |
|---|---|---|---|
| Node | `.nvmrc` 24, engines `>=20` | `.nvmrc` 24, engines `>=22.12.0` | Node 20 is EOL (2026-04-30). 22.12+ has unflagged `require(esm)` (needed for ESM-only `@octokit/rest` 22, `pixelmatch` 7, `@anthropic-ai/claude-agent-sdk`) and `node --test` globs. 00 §14.1. |
| TS module system | `module: commonjs`, `moduleResolution: node` | `module: nodenext`, `moduleResolution: nodenext`, package `"type": "commonjs"` | Still emits CommonJS (ts-node-dev, decorators, Uply code unchanged), but resolves `exports` maps and allows `import` of ESM-only packages (TS ≥5.8 + Node ≥22.12). Verified: tsc, ts-node, ts-node-dev all load `@octokit/rest`, `pixelmatch`, `@anthropic-ai/claude-agent-sdk` statically. |
| TS strictness | `strict`, unused/fallthrough/override | + `noUncheckedIndexedAccess`, `noImplicitReturns`, `isolatedModules`; `exactOptionalPropertyTypes` **off** | Index access is the main source of runtime `undefined` in pipeline code (arrays of components, regex groups, `Record` lookups). |
| Path aliases | `baseUrl: ./src` + `tsconfig-paths/register` | none; relative imports + barrels | Removes a runtime hook; Uply code already uses relative imports. |
| ESLint preset | `recommendedTypeChecked` + bulk suppressions file | `strictTypeChecked`, **no suppressions file** | Greenfield; nothing to baseline. |
| Validation tuple | `[boolean, ApiResponse \| null, T \| null]`, callers use `errorResponse!`/`dto!` | discriminated tuple, no `!` (§5.7.1) | `no-non-null-assertion` is on in `strictTypeChecked`. Controller shape from guidelines §4.3 is otherwise unchanged. |
| HTTP wire format | `ResponseHandler` sends raw `data`, errors as `{ statusCode, message, error }` | envelope `{ status, data }` / `{ status, error, error_reason }` (§5.7.1) | 00 §14.2: the guidelines §6 envelope on the wire. |
| `Table` enum | camelCase values = schema export names, `schema[table]` lookup | snake_case SQL names (00 §5) resolved by `database/table-registry.ts` | 00 §14.3; exhaustive `Record<Table, PgTable>`. |
| Child-process env | `process.env` inherited | explicit allow-list `CHILD_PROCESS_BASE_ENV` (§5.9.2) | 00 §14.5. |
| Logging | `console.*` everywhere | pino `logger` (`utilities/loggers/logger.ts`), redaction, `no-console` error | Hardening plan §3.1 already prescribes this for Uply. |
| DB config | `DB_HOST`/`DB_PORT`/… | `DATABASE_URL` | 00 §4. |
| Redis config | host/port consts + env overrides | `REDIS_URL` | 00 §4. |
| Domain enums | TS `enum` + `pgEnum` | `as const` object + same-name union type + `*_VALUES` tuple; Postgres `text` + `CHECK` | 00 §5. |
| Drizzle table extras | `(t) => ({ idx: index(...) })` (object form) | `(t) => [index(...), check(...)]` (array form) | Object form is deprecated in drizzle-orm ≥0.36; Uply is on 0.45. |
| `updatedAt` | manual stamping in `QueryHandlerDrizzle` | `$onUpdate(() => new Date())` on the column **and** QueryHandler stamping | Covers direct-Drizzle updates too (hardening plan §3.2). |
| `QueryHandler` db type | `private db: any` | `NodePgDatabase<typeof schema> \| PgTransaction<…>` | `no-explicit-any`. |
| `.env` | `backend/.env`, dotenv `override: true` | repo-root `.env`, `override: false`, `quiet: true`, not loaded under `NODE_ENV=test` | 00 §4 puts `.env.example` at the root; shell env must win; tests are hermetic (00 §14.10). |
| Config reads | `requireEnv` throws at import | reads never throw; `""`/`NaN` are reported by `validateConfig()` at boot (§5.10) | Importing config never fails in tests or drizzle-kit; boot lists every problem at once. |
| Angular DI | constructor injection in `ApiService` | `inject()` only | Task decision. |
| Angular inputs | `@Input()` decorators, getters | `input()` / `input.required()` / `output()` / `model()` signals | `prefer-signals`. |
| Change detection | Default everywhere (0 OnPush components) | `ChangeDetectionStrategy.OnPush` everywhere | Task decision. |
| Template helpers | `CommonModule` + `[ngClass]` | class bindings `[class.x]` / `[class]`, built-in control flow | No `CommonModule` imports in new components. |
| Frontend lint | many rules at `warn`, a11y rules off | `strictTypeChecked` + Angular a11y at `error` | `--max-warnings 0`. |

Anything not in this table follows Uply-v2 as it is.

### 5.2 TypeScript configuration

#### 5.2.1 Backend (`backend/tsconfig.json`)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "rootDir": "src",
    "outDir": "dist",
    "sourceMap": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "strictPropertyInitialization": false,
    "noImplicitReturns": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "harness-templates"]
}
```

`backend/harness-templates/**` (sheet 10's TSX/HTML copied into worktrees) is outside `include`, listed in
`exclude`, ignored by ESLint (§5.3.1) and by Prettier (§5.4) — 00 §14.1.

`backend/tsconfig.eslint.json` (used by `typecheck` and typed lint; covers tests and scripts outside `src`):

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true, "rootDir": ".." },
  "include": ["src/**/*.ts", "scripts/**/*.ts", "drizzle.config.ts", "../tests/backend/**/*.ts"],
  "exclude": ["dist", "node_modules", "harness-templates"]
}
```

`npm run typecheck` uses this file, so `tests/backend/**` is type-checked too (no separate `tsconfig.test.json`).

Notes an agent must know:

- `strictPropertyInitialization: false` is kept from Uply only because generated models (`private _id: number;`) and DTOs (`name!: string`) rely on it. Hand-written classes must still initialise fields in the constructor or at declaration.
- `module: nodenext` with `"type": "commonjs"` in `backend/package.json` (and no `"type"` in the root `package.json`) means every `.ts` file under `backend/` and `tests/` compiles to CommonJS. Do not add `"type": "module"` anywhere. Do not use top-level `await`.
- Do not enable `verbatimModuleSyntax`: it forbids `import x from` in CommonJS output. Type-only imports are enforced by ESLint (`consistent-type-imports`) instead.
- ESM-only packages are imported normally (`import { Octokit } from "@octokit/rest";`). Node ≥22.12 loads them through `require(esm)`. If a future ESM-only package uses top-level await, load it with `await import("pkg")` inside an async function (TS keeps dynamic `import()` under `nodenext`).
- TypeScript stays on **5.9.x** (`^5.9.2`). TypeScript 7 (native compiler) is out of bounds: its JS compiler API differs and sheet 08 uses the 5.x compiler API at runtime.

#### 5.2.2 Frontend (`frontend/tsconfig.json`)

Uply-v2's tenant-frontend config plus `noUncheckedIndexedAccess`:

```json
{
  "compileOnSave": false,
  "compilerOptions": {
    "outDir": "./dist/out-tsc",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "experimentalDecorators": true,
    "moduleResolution": "bundler",
    "importHelpers": true,
    "target": "ES2022",
    "module": "ES2022"
  },
  "angularCompilerOptions": {
    "enableI18nLegacyMessageIdFormat": false,
    "strictInjectionParameters": true,
    "strictInputAccessModifiers": true,
    "strictTemplates": true
  }
}
```

`frontend/tsconfig.app.json` and `frontend/tsconfig.spec.json` are Uply's files unchanged:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "outDir": "./out-tsc/app", "types": [] },
  "files": ["src/main.ts"],
  "include": ["src/**/*.d.ts"]
}
```

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "outDir": "./out-tsc/spec", "types": ["jasmine"] },
  "include": ["src/**/*.spec.ts", "src/**/*.d.ts"]
}
```

Frontend TypeScript stays on `~5.7.2` (Uply parity; Angular 19.2 supports `>=5.5 <5.9`).

### 5.3 ESLint

#### 5.3.1 Backend (`backend/eslint.config.js`, CommonJS flat config)

Derived from Uply-v2's `backend/eslint.config.js` (same layer bans, same `sql.raw` and raw-response bans, same lint-from-repo-root trick) with: `strictTypeChecked`, child-process bans, `shell: true` ban, services may not import controllers, `sql.raw` allowed only in `schema.ts`, no suppressions file. Verified with eslint 9.39 + typescript-eslint 8.71.

```js
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
```

`src/models/**` is generated (never imports anything, never hand-edited) and therefore ignored; `models:drift` (02) guarantees it equals generator output.

Lint is run with `--max-warnings 0`. There is **no** `eslint-suppressions.json`. An inline disable needs a reason and must be specific:

```ts
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Octokit types say non-null; API returns null for ghost users
const login = pr.user?.login ?? "ghost";
```

#### 5.3.2 Frontend (`frontend/eslint.config.mjs`)

Uply's `angular-eslint` flat config raised to `strictTypeChecked`, warnings promoted to errors, a11y rules on. Verified with angular-eslint 19.8 against an OnPush/signal component.

```js
// @ts-check
// ESLint flat config for the PRVision frontend. Spec: docs/specs/01-engineering-standards.md §5.3.2.
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.angular/**', 'scripts/**'] },
  {
    files: ['src/**/*.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
      ...angular.configs.tsRecommended,
    ],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/component-selector': ['error', { type: 'element', prefix: 'app', style: 'kebab-case' }],
      '@angular-eslint/directive-selector': ['error', { type: 'attribute', prefix: 'app', style: 'camelCase' }],
      '@angular-eslint/prefer-on-push-component-change-detection': 'error',
      '@angular-eslint/prefer-standalone': 'error',
      '@angular-eslint/prefer-inject': 'error',
      '@angular-eslint/prefer-signals': 'error',
      '@angular-eslint/prefer-output-readonly': 'error',
      '@angular-eslint/no-async-lifecycle-method': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    files: ['src/**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  {
    files: ['src/**/*.html'],
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
    rules: {
      '@angular-eslint/template/prefer-control-flow': 'error',
      '@angular-eslint/template/prefer-self-closing-tags': 'error',
      '@angular-eslint/template/button-has-type': 'error',
      '@angular-eslint/template/eqeqeq': 'error',
      '@angular-eslint/template/no-any': 'error',
    },
  },
);
```

`frontend/angular.json` wires `ng lint` to `@angular-eslint/builder:lint` with `lintFilePatterns: ["src/**/*.ts", "src/**/*.html"]` (02). Inline templates are linted by the `.html` rules through `processInlineTemplates`.

### 5.4 Prettier and EditorConfig

`backend/.prettierrc.json` — Uply's file verbatim:

```json
{
  "printWidth": 120,
  "tabWidth": 2,
  "useTabs": false,
  "semi": true,
  "singleQuote": false,
  "quoteProps": "as-needed",
  "trailingComma": "none",
  "bracketSpacing": true,
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

`frontend/.prettierrc.json` — matches the style Uply's tenant-frontend is actually written in (single quotes, trailing commas, ~120 columns); Uply has no frontend Prettier file, so this formalises it:

```json
{
  "printWidth": 120,
  "tabWidth": 2,
  "useTabs": false,
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "bracketSpacing": true,
  "arrowParens": "always",
  "endOfLine": "lf",
  "overrides": [{ "files": "*.html", "options": { "parser": "angular" } }]
}
```

`backend/.prettierignore`:

```text
node_modules/
dist/
# Generated by `npm run generate:models`; formatting them would make models:drift fail.
src/models/
# Generated by drizzle-kit; applied migrations are never edited.
src/database/migrations/
harness-templates/
package-lock.json
```

`frontend/.prettierignore`:

```text
node_modules/
dist/
.angular/
coverage/
package-lock.json
```

Root `.editorconfig` (Uply tenant-frontend's file, made repo-wide):

```ini
root = true

[*]
charset = utf-8
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true

[backend/**.{ts,js,mjs}]
quote_type = double

[frontend/**.ts]
quote_type = single

[*.md]
max_line_length = off
trim_trailing_whitespace = false
```

Prettier owns formatting. ESLint has no stylistic formatting rules beyond `curly` and `eqeqeq`. Never hand-format against Prettier; run `npm run format`.

### 5.5 Naming and file conventions

Aligned with ARCHITECTURE_GUIDELINES §11 and the names in 00 §7.

#### 5.5.1 Backend files

| Kind | File name | Class / export | Example |
|---|---|---|---|
| Controller | `controllers/<feature>-controller.ts` | `<Feature>Controller` | `controllers/repositories-controller.ts` → `RepositoriesController` |
| HTTP service | `services/<feature>/<feature>-service.ts` | `<Feature>Service` | `services/repositories/repositories-service.ts` |
| Non-HTTP service | `services/<area>/<thing>-service.ts` | `<Thing>Service` | `services/visualizations/pipeline/render-service.ts` → `RenderService` |
| Request DTO | `dtos/<feature>/<feature>-<action>.dto.ts` | `<Feature><Action>DTO` | `dtos/repositories/repository-create.dto.ts` → `RepositoryCreateDTO` |
| Query DTO | `dtos/<feature>/<feature>-<name>-query.dto.ts` | `<Feature><Name>QueryDTO` | `VisualizationListQueryDTO` |
| Param DTO | `dtos/shared/id-param.dto.ts` | `IdParamDTO` | — |
| View DTO | `dtos/<feature>/<feature>-view.dto.ts` | `interface <Feature>View` + `function to<Feature>View(...)` | `RepositoryView`, `toRepositoryView(model)` (names from 00 §9) |
| Model (generated) | `models/<entity>-model.ts` | `<Entity>Model` | `models/repository-model.ts` → `RepositoryModel` |
| Middleware | `middleware/<name>-middleware.ts` | `<Name>Middleware` | `LocalAuthMiddleware` |
| Utility handler | `utilities/handlers/<name>-handler.ts` | `<Name>Handler` | `ResponseHandler`, `QueryHandler` |
| Utility service | `utilities/services/<name>.ts` | `<Name>` | `GitClient`, `ArtifactStore`, `QueueService` |
| Helper | `utilities/helpers/<name>.ts` | functions | `getErrorMessage`, `runProcess` |
| Config | `config-consts/<area>.config.ts` | `SCREAMING_SNAKE` constants (required env values are `""` when unset) | `APP_PORT`, `DATABASE_URL` |
| Enum | `enums/domain/<kebab-name>.ts`, `enums/utility/table.ts` | `as const` object + same-name type + `<NAME>_VALUES` | §5.5.3 |
| Types | `types/<area>.ts` | interfaces/types/classes | `types/visualization-pipeline.ts` |
| Test | `tests/backend/<area>/<subject>.test.ts` | — | `tests/backend/services/repositories-service.test.ts` |

Rules:

- Files are kebab-case. One primary class per file; the file name is the class name in kebab-case plus the role suffix.
- Uply's DTO suffix is uppercase `DTO` (`MonitorTagSaveDTO`); keep it.
- Methods are verbs (`createVisualization`, `listPullRequests`). No `Async` suffix. Boolean names start with `is/has/should/can`.
- Private members are `private readonly` without underscore. Underscore-prefixed fields exist only in generated models.
- Constants: `SCREAMING_SNAKE_CASE` with a unit suffix for quantities: `_MS`, `_SECONDS`, `_BYTES`, `_PX`, `_COUNT`/no suffix for plain counts (`MAX_PAGE_SIZE`).
- Interfaces are not prefixed with `I`. Type aliases for unions, interfaces for object shapes.
- JSDoc on every exported class and public method (Uply style: one-paragraph intent, `@param`/`@returns` when non-obvious). Controllers keep Uply's one-line section comments (`// Collect and validate data against DTO`).

#### 5.5.2 Database naming

| Thing | Convention | Example |
|---|---|---|
| Table | snake_case plural | `visualization_components` |
| Column | snake_case | `diff_pixel_ratio` |
| Drizzle export | camelCase of table | `visualizationComponents` |
| Drizzle property | camelCase of column (00 §6) | `diffPixelRatio` |
| Index | `<table>_<col>[_<col>]_idx` | `visualizations_repository_id_created_at_idx` |
| Unique index | `<table>_<col>[_<col>]_key` (partial: add `_active`) | `repositories_local_path_active_key` (03) |
| Check | `<table>_<col>_check` | `visualizations_status_check` |
| FK | drizzle default (`<table>_<col>_<ref>_<refcol>_fk`) | — |

#### 5.5.3 Enums (00 §5 shape, plus derived helpers)

```ts
// backend/src/enums/domain/visualization-status.ts (full bodies: 03 §5)
import { enumValues, type ValueOf } from "../utility/value-of";

export const VisualizationStatus = {
  QUEUED: "queued",
  PREPARING: "preparing",
  // ...exact values from 00 §5
  CANCELLED: "cancelled"
} as const;
export type VisualizationStatus = ValueOf<typeof VisualizationStatus>;
/** Non-empty tuple for drizzle `text(..., { enum })`, CHECK constraints and class-validator `@IsIn`. */
export const VISUALIZATION_STATUS_VALUES = enumValues(VisualizationStatus);
```

Good / bad:

```ts
// Good: compare against the const member, type with the union
if (row.status === VisualizationStatus.COMPLETED) { … }
function setStatus(status: VisualizationStatus): void { … }

// Bad: TS enum (00 §5 forbids), magic strings, widening to string
enum VisualizationStatus { QUEUED = "queued" }
if (row.status === "completed") { … }
function setStatus(status: string): void { … }
```

#### 5.5.4 Frontend files

| Kind | File | Symbol |
|---|---|---|
| Routed page | `features/<feature>/<page>/<page>.component.ts` (+ `.html`/`.scss` when template > ~80 lines) | `<Page>Component`, selector `app-<page>` |
| Feature-local component | `features/<feature>/components/<name>/<name>.component.ts` | `<Name>Component` |
| Shared component | `shared/components/<name>/<name>.component.ts` | as Uply (`StatusPillComponent`, `DataGridComponent`, `EmptyStateComponent`) |
| Pipe | `shared/pipes/<name>.pipe.ts` | `<Name>Pipe` (`RelativeTimePipe` in `relative-time.pipe.ts`, pipe name `relativeTime`; 12) |
| Service | `core/services/<name>.service.ts` | `<Name>Service` |
| Interceptor | `core/interceptors/<name>.interceptor.ts` | `const <name>Interceptor: HttpInterceptorFn` |
| Model | `core/models/<area>.model.ts` | interfaces named exactly as 00 §9 (`RepositoryView`, …) |
| Constants | `core/constants/<area>.constants.ts` | `SCREAMING_SNAKE` |
| Utils | `core/utils/<name>.util.ts` | functions |
| Spec | next to the file, `<file>.spec.ts` | — |

### 5.6 Folder and barrel rules

#### 5.6.1 Backend tree (00 §7 is authoritative for file names)

```text
backend/src/
  app.ts  worker.ts                    composition roots (no logic)
  routes/index.ts                      single explicit route map
  config-consts/                       all configuration + the only env readers
  middleware/                          LocalAuthMiddleware and request middleware
  controllers/                         thin HTTP controllers (one file per resource)
  services/<feature>/                  business logic; services/visualizations/pipeline/ for worker steps
  dtos/<feature>/                      class-validator DTOs and view interfaces
  models/                              generated, never hand-edited
  database/schema.ts + migrations/     Drizzle schema (single file) and drizzle-kit output
  enums/{domain,utility}/              as-const enums
  types/                               cross-sheet TS contracts (00 §8) and error classes
  utilities/{handlers,validation,mappers,context,processors,helpers,loggers,services}/
backend/harness-templates/             static files copied into worktrees (sheet 10)
backend/scripts/                       maintenance scripts (ts via ts-node, or .mjs)
```

Controllers are flat in `controllers/` (00 §7 lists `controllers/{health,settings,repositories,visualizations}-controller.ts`); Uply's per-feature controller sub-folders are not used.

#### 5.6.2 Barrels

Barrels (`index.ts`) exist at these boundaries only: `config-consts/`, `controllers/`, `dtos/`, `enums/`, `middleware/`, `models/` (generated), `services/` (exports HTTP-facing services only), `types/`, `utilities/`, `utilities/context/`, `utilities/mappers/`.

- Import **across** layers through the barrel: `import { ResponseHandler, Validation } from "../utilities";`.
- Import **within** a layer by relative path to the sibling file, never through your own layer's barrel (prevents cycles; `import-x/no-cycle` enforces).
- Barrels are explicit lists of `export * from "./file";` — never re-export another barrel.
- `utilities/index.ts` must **not** re-export `helpers/env.ts` (only `config-consts` may use it, §5.10) nor pipeline-specific services.
- `config-consts/index.ts` must **not** re-export `config-validation.ts` (it imports the barrel); import it by path.
- `types/index.ts` exports `visualization-pipeline.ts` only (which re-exports `pipeline-errors.ts`, 00 §14.7) plus `local-user.ts`; exporting both pipeline files with `export *` would be an ambiguous re-export.
- Pipeline step services (`services/visualizations/pipeline/*`) are imported by relative path by the orchestrator; they are not in `services/index.ts`.
- Type-only imports use `import type` (enforced).

```ts
// Good (inside services/visualizations/visualizations-service.ts)
import type { VisualizationCreateDTO } from "../../dtos";
import { Table, VisualizationStatus } from "../../enums";
import { QueryHandler, QueueService, type ApiResponse } from "../../utilities";   // fixStyle may split this

// Bad
import { QueryHandler } from "../../utilities/handlers/query-handler";   // deep path when a barrel exists
import { RepositoriesService } from "../index";                           // own-layer barrel → cycle risk
```

#### 5.6.3 Layer import matrix (enforced by §5.3.1)

| From \ may import | express | drizzle-orm / pg / database | services | controllers | utilities | dtos | models | enums/types/config |
|---|---|---|---|---|---|---|---|---|
| routes | yes | no | no | types only | yes | no | no | yes |
| controllers | yes | **no** | yes | — | yes | yes | yes | yes |
| services | **no** | yes (QueryHandler default; direct Drizzle needs comment) | yes | **no** | yes | types only | yes | yes |
| utilities | **no** (except `context/`, `response-handler.ts`) | yes | no | no | yes | no | yes | yes |
| dtos | no | **no** | **no** | no | `validation` only | yes | no | yes |
| models | no | no | **no** | no | no | no | — | no (`class-validator` banned) |

#### 5.6.4 Architecture script rules (`npm run check:architecture`)

- `direct-drizzle`: a `src/services/**` file importing `drizzle-orm` must contain `// Direct Drizzle: <why QueryHandler is insufficient>`.
- `process-env`: `process.env` only in `src/config-consts/**` and `src/utilities/helpers/env.ts`.
- `env-helper`: `utilities/helpers/env` imported only from `src/config-consts/**`.
- `utilities-services`: no file under `src/utilities/**` imports a module under `src/services/**` (04 §9.4, 05 §1).

No baseline file: any offender fails.

### 5.7 Error handling model

Three kinds of failure, three mechanisms. Never mix them.

| Where | Mechanism | Expected failure | Unexpected failure |
|---|---|---|---|
| HTTP-facing service (settings, repositories, visualizations, health) | returns `ApiResponse` | `return { status: 4xx, error: "Human message", error_reason: "<code>" }` | catch at method boundary → `logger.error(...)` → `return { status: 500, error: "Internal server error", error_reason: "internal_error" }` |
| Pipeline step service (07–11 `services/visualizations/pipeline/*`) | returns typed result (00 §8); throws only `PipelineStepError` | per-component problems captured in the result (`render_status`, `base_error`, `head_error`, `skipped`) | visualization-fatal problems → `throw new PipelineStepError(stage, userMessage, { cause })` |
| AI provider (05) | throws `AiProviderError` (00 §8) | — | consumers (09, 11) catch and translate (§5.7.4) |
| Controller | catches everything | — | `responseHandler.internalError()` (generic message; never `error.message`, which can contain paths or command output) |
| Programmer error (bug, broken invariant) | `throw new Error("…")` | — | bubbles to the nearest boundary above |

General rules:

- Throw only `Error` instances. Wrap with `{ cause }` when rethrowing. Never `throw "string"`.
- `catch (error)` variables are `unknown`; use `getErrorMessage(error)` (`utilities/helpers/error-message.ts`, copied from Uply) or `instanceof` narrowing.
- Never swallow: every `catch` either returns a structured result, rethrows, or logs at `warn`/`error` with the reason it is safe to continue.
- Do not use exceptions for control flow inside HTTP services; return early with `ApiResponse`.

#### 5.7.1 HTTP: `ApiResponse`, wire format and the typed validation tuple

`ApiResponse` and `ResponseHandler` live in `utilities/handlers/response-handler.ts` (04 §8.1, adapted from Uply).
The **wire format is the envelope** of 00 §14.2 and guidelines §6 — a deliberate improvement over Uply, whose
`ResponseHandler` sends raw data. The HTTP status code always equals `status`:

| `ApiResponse` | HTTP body |
|---|---|
| `{ status: 200, data: X }` | `{ "status": 200, "data": X }` (`data: null` when undefined) |
| `{ status: 202, data: X }` | `{ "status": 202, "data": X }` |
| `{ status: 404, error: "Repository not found", error_reason: "not_found" }` | `{ "status": 404, "error": "Repository not found", "error_reason": "not_found" }` |
| validation failure | `{ "status": 400, "error": ["name must be a string", …], "error_reason": "validation_failed" }` |
| `{ status: 500, error: "Internal server error" }` | `{ "status": 500, "error": "Internal server error", "error_reason": "internal_error" }` |

There are no 204 responses (every response has a JSON body). `error` is a string, or a string array only for
`validation_failed`.

`Validation.validate` (04) returns a discriminated tuple so controllers need no non-null assertions:

```ts
export type ValidationResult<T> = [true, null, T] | [false, ApiResponse<never>, null];
```

Controller method (guidelines §4.3 shape, PRVision mechanics):

```ts
/**
 * Register a local clone as a repository.
 */
async create(req: Request, res: Response): Promise<Response> {
  try {
    // Collect and validate data against DTO
    const sanitized = this.validation.compileJsonData(req.body);
    const [isValid, errorResponse, dto] = await this.validation.validate(sanitized, RepositoryCreateDTO);
    if (!isValid) {
      return this.responseHandler.controllerResponse(errorResponse, res);   // narrowed: ApiResponse
    }

    // Map to model and create
    const model = DTOMapper.map(dto, RepositoryModel);                       // narrowed: RepositoryCreateDTO
    const service = new RepositoriesService(model);
    const serviceResponse = await service.create();
    return this.responseHandler.controllerResponse(serviceResponse, res);
  } catch (error) {
    logger.error({ event: "http.controller.failed", err: error }, "RepositoriesController.create failed");
    return this.responseHandler.controllerResponse(this.responseHandler.internalError(), res);   // never error.message
  }
}
```

Bad:

```ts
if (!isValid) return res.status(400).json(errorResponse);   // raw response (lint error) + no braces
const model = DTOMapper.map(dto!, RepositoryModel);          // non-null assertion (lint error)
```

Status code defaults (a sheet may deviate only by saying so explicitly):

| Situation | Status | `error_reason` |
|---|---|---|
| DTO/param/query validation failed, malformed JSON | 400 | `validation_failed` |
| Host or Origin rejected by `LocalAuthMiddleware` | 403 | `forbidden_origin` |
| Row missing or soft-deleted, unknown route, missing artifact | 404 | `not_found` |
| Cancel a finished visualization | 409 | `already_terminal` |
| Unique/FK violation, delete while non-terminal | 409 | `conflict` |
| Body over `JSON_BODY_LIMIT` | 413 | `payload_too_large` |
| Input is well-formed but semantically unusable | 400 | `not_git_repo`, `unsupported_framework`, `missing_node_modules`, `no_github_remote`, `working_tree_clean` |
| Required configuration missing | 400 | `github_token_missing`, `ai_not_configured` |
| Stored or submitted credential rejected by GitHub / Anthropic / Claude Code | 400 | `github_unauthorized`, `ai_unauthorized` |
| GitHub rate limit | 429 | `github_rate_limited` |
| GitHub unreachable / 5xx / unexpected GitHub error | 502 | `github_unavailable` |
| The AI provider itself fails during `POST /api/settings/test-ai` (rate limit, network, refusal, invalid output, check-value mismatch) | 502 | `internal_error` (05 §5.8; 00 has no AI-specific upstream code) |
| A settings connection test (`test-github`, `test-ai`) exceeded its own timeout | 504 | `internal_error` (message names the timeout, 05 §5.8) |
| Anything unexpected | 500 | `internal_error` |

Never return 401: PRVision has no login, and Uply's frontend interceptor pattern treats 401 as "log out".
403 is used only for `forbidden_origin`. A rejected credential is the user's input problem (fix it in Settings),
so it is 400 with a specific `error_reason`, which the UI turns into an action; 502 is reserved for an
unreachable or failing upstream. This table is the 00 §14.12 status mapping. Sheets 05–07 follow it; 422 and 412 are not used. `error_reason` values must come from
the complete list in 00 §14.2 (`ErrorReason` in 04 §8.2); a sheet that needs a new code lists it in its own
"Contract changes requested".

Service shape for expected failures:

```ts
async get(id: number): Promise<ApiResponse> {
  try {
    const repository = await this.queryHandler.validateAndSelect(RepositoryModel, { id }, Table.REPOSITORIES);
    if (!repository) {
      return { status: 404, error: "Repository not found", error_reason: "not_found" };
    }
    return { status: 200, data: toRepositoryView(repository) };
  } catch (error) {
    logger.error({ event: "repositories.get.failed", repositoryId: id, err: error }, "Repository get failed");
    return { status: 500, error: "Internal server error", error_reason: "internal_error" };
  }
}
```

#### 5.7.2 Pipeline steps: typed results, per-component capture

Step services (`ChangeAnalysisService`, `HarnessGenerationService`, `RenderService`, `ImageDiffService`, `StructuralDiffService`, `SummaryService`, `WorkspacePrepareService`) take `PipelineContext` (00 §8) and return the typed results from 00 §8.

- A failure that affects **one component** (harness invalid, Vite compile error in one file, screenshot timeout, AI refusal for one component) is recorded on that component and processing continues.
- A failure that makes the **whole visualization** meaningless (worktree creation failed, Vite cannot start for either side, AI not configured) throws `PipelineStepError`. Zero renderable candidates is *not* fatal: the run completes with 0 components.
- Cancellation: call `ctx.signal.throwIfAborted()` between units of work and pass `ctx.signal` to every awaitable that accepts one (AI providers, `runProcess`, `fetch`). The job signal aborts with the **string** reason `"cancelled"` or `"shutdown"` (00 §14.6), or with a `TimeoutError` when 07's overall timeout fires; `throwIfAborted()` and signal-aware APIs reject with exactly that reason, so the thrown value may be a string, not an `Error`. Step services never swallow anything while `ctx.signal.aborted` is true; they clean up and rethrow what they caught unchanged. The orchestrator (07) decides the outcome from `ctx.signal.aborted` and `jobAbortReason(signal)` (04 §9.4), never from the type or name of the thrown value.
- Timeouts are not cancellation: `AbortSignal.timeout()` aborts with a `TimeoutError` (not `AbortError`). A per-component timeout is a component failure; decide by checking `ctx.signal.aborted`, not the error name.
- Never assume a caught value is an `Error`: use `getErrorMessage(error)` (handles strings) and `instanceof` narrowing.

```ts
// Good: per-component failure is data
for (const candidate of candidates) {
  ctx.signal.throwIfAborted();
  try {
    results.push(await this.renderOne(ctx, candidate));
  } catch (error) {
    if (ctx.signal.aborted) {
      throw error;                       // cancellation, not a component failure
    }
    await ctx.console.warn("rendering", `${candidate.displayName}: render failed (${getErrorMessage(error)})`);
    results.push(this.failedResult(candidate, getErrorMessage(error)));
  }
}

// Bad: one broken component fails the run
for (const candidate of candidates) {
  results.push(await this.renderOne(ctx, candidate));   // any throw kills the visualization
}
```

#### 5.7.3 `PipelineStepError` (exact code; file `backend/src/types/pipeline-errors.ts`)

00 §14.7 fixes the location and 00 §14.12 the constructor `new PipelineStepError(stage, userMessage, options?: { cause?; detail?; code? })`,
with `stage` typed as the non-terminal `VisualizationStatus` values. Created by 02 in the scaffold and
re-exported from `types/visualization-pipeline.ts`; 04 §10 repeats the identical code. Always positional — never
`new PipelineStepError({ stage, userMessage, … })`.

```ts
import type { NonTerminalVisualizationStatus } from "../enums";

/**
 * Stage a fatal pipeline failure is attributed to (00 §14.7): every non-terminal VisualizationStatus
 * (queued + the working stages, 00 §11). 07 stores it in visualizations.failed_stage (00 §14.3).
 */
export type PipelineStage = NonTerminalVisualizationStatus;

export interface PipelineStepErrorOptions {
  /** Underlying error; logged through the err serializer, never shown to users. */
  cause?: unknown;
  /** Technical detail for logs; becomes `message`. Defaults to userMessage. */
  detail?: string;
  /** Machine hint for the orchestrator, e.g. a GitErrorCode such as "auth_failed". */
  code?: string;
}

/**
 * The only error pipeline step services (07–11) may throw. Fatal for the visualization.
 * - message:     internal detail for logs (redacted by the logger's err serializer)
 * - userMessage: one safe sentence stored in visualizations.error_message and shown in the UI
 * Per-component failures are recorded in results, never thrown.
 */
export class PipelineStepError extends Error {
  override readonly name = "PipelineStepError";
  readonly stage: PipelineStage;
  readonly userMessage: string;
  readonly code: string | null;

  constructor(stage: PipelineStage, userMessage: string, options: PipelineStepErrorOptions = {}) {
    super(options.detail ?? userMessage, { cause: options.cause });
    this.stage = stage;
    this.userMessage = userMessage;
    this.code = options.code ?? null;
  }
}

/** Type guard used by the orchestrator (07). */
export function isPipelineStepError(error: unknown): error is PipelineStepError {
  return error instanceof PipelineStepError;
}

/**
 * True for the DOMException named "AbortError" (AbortSignal.abort() without a reason, aborted fetch).
 * NOT a cancellation test: a job signal aborts with the string reason "cancelled" | "shutdown" (00 §14.6) and
 * a timeout with a TimeoutError. Decide cancellation by `signal.aborted` and `jobAbortReason(signal)` (04 §9.4).
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
```

`userMessage` rules: one sentence, no stack, no secrets, no absolute home paths (use repo-relative paths), actionable when possible ("Vite failed to start for the head worktree. Check that `npm install` was run in the registered clone.").

#### 5.7.4 `AiProviderError` handling (consumers 09, 11)

`AiProviderError(message, reason, retryable, usage?)` is defined in 00 §8 + §14.4 (`usage` carries tokens spent on a failed call; consumers add it to the run's usage through 09's `AiUsageRecorder`). Default translation:

| `reason` | Consumer action |
|---|---|
| `auth`, `config` | fatal: `throw new PipelineStepError(stage, "AI provider is not configured or rejected the credentials. Fix it in Settings.", { cause })` |
| `aborted` | rethrow (cancellation) |
| `rate_limit`, `network` with `retryable` | provider already retried (SDK `maxRetries`); consumer records a component failure and continues |
| `refusal`, `max_tokens`, `invalid_output`, `unknown` | record a component failure (`harness_notes` / `ai_note` carries a short reason) and continue |

Providers must never put prompt text, API keys or response bodies in `message`.

### 5.8 Logging rules

`utilities/loggers/logger.ts` (04) exports a pino logger. Required behaviour:

- `export const logger: pino.Logger` created once, level from `LOG_LEVEL` (`config-consts`; an invalid value falls back to `info` so import never throws, and `validateConfig()` reports it).
- `NODE_ENV=development` → `pino-pretty` transport (colorized, `translateTime: "SYS:HH:MM:ss.l"`, `ignore: "pid,hostname,app"`); `NODE_ENV=test` → the `logTestStream` destination (00 §14.10; tests subscribe to it, nothing is printed unless `PRVISION_TEST_LOG_STDOUT=1`); otherwise JSON to stdout.
- Base bindings: `{ app: "prvision", pid }`; every module creates its logger with `createLogger("<module>")`, which adds `{ module }`. A `requestId` is mixed in from `AuthContext` for request- and job-scoped lines.
- Serializer: `err` wraps `pino.stdSerializers.err` (stack, message, `cause`), drops HTTP request/response objects, runs `redactSecrets()` over message/stack/stderr, and passes non-`Error` values (an abort reason string) through.
- Redaction: censor `"[REDACTED]"`, key list `REDACT_PATHS` in 04 §9.10 (tokens, API keys, ciphertext columns, passwords, secrets, authorization/cookie headers, `env`, connection URLs). Free text is scrubbed by `redactSecrets()` (GitHub/Anthropic token shapes, `Authorization:` values, credentials in URLs, the literal `PRVISION_SECRET_KEY`).

Rules for callers:

- `console.*` is a lint error outside `utilities/loggers/**` and `backend/scripts/**`. Scripts print with `console` (they are CLIs).
- Signature: `logger.<level>({ event, ...fields }, "Static human message")`. The message is a constant string; variable data goes in the object.
- `event` is required and dot-cased `<area>.<entity>.<action>`: `http.request.completed`, `queue.job.started`, `git.command.failed`, `ai.request.completed`, `render.page.failed`, `visualization.stage.completed`.
- Use `logger.child({ visualizationId, stage })` inside the worker so every line carries the ids.
- Errors: `logger.error({ event, err: error }, "…")` — key must be `err` so the serializer runs.
- Never log: tokens, API keys, `PRVISION_SECRET_KEY`, `DATABASE_URL` with password, decrypted settings, full `process.env`, child-process `env`, AI prompts or responses at `info` or above, harness source at `info` or above. At `debug`, truncate any free text to `LOG_TEXT_MAX_LENGTH` (2 000 chars).
- Levels: `fatal` (process will exit), `error` (operation failed, user impact), `warn` (degraded but continuing: one component failed, retry), `info` (lifecycle: boot, request completed, job started/finished, stage completed), `debug` (diagnostics: git args, timings per component), `trace` (never committed enabled).

```ts
// Good
logger.info({ event: "visualization.stage.completed", visualizationId, stage: "rendering", durationMs }, "Stage completed");

// Bad
console.log(`Rendered viz ${id} with key ${apiKey}`);                 // console + secret
logger.info(`Stage ${stage} completed for ${visualizationId}`);       // data in message, no event
```

Logs vs console events: **logs** are for developers (stdout). **Console events** (`visualization_console_events`, written via `PipelineContext.console.info/warn/error(stage, message)`) are user-facing progress shown in the UI. Every console event is also logged by `VisualizationConsoleService` (07); not every log is a console event. Console event `stage` is a `VisualizationStatus` value (00 §14.4; CHECKed by 03) — normally a working stage (`preparing` … `summarizing`); component names go in the message, never in `stage`. Messages are one human sentence, ≤ `CONSOLE_MESSAGE_MAX_LENGTH` (4 000) chars, passed through `redactSecrets()`, repo-relative paths.

### 5.9 Async and child-process rules

#### 5.9.1 Async

- `async`/`await` only. No `.then()` chains in TypeScript source (allowed: `promise.catch(handler)` at a top-level boundary).
- No floating promises (`ignoreVoid: false`: `void promise` is also an error). Fire-and-forget at process boundaries is written as `shutdown().catch((error: unknown) => { logger.fatal({ event: "process.shutdown.failed", err: error }, "Shutdown failed"); process.exit(1); });`.
- Independent work: `await Promise.all([...])`. When partial failure is acceptable: `Promise.allSettled` and inspect each result.
- Bounded concurrency for N items (render pages, AI calls): implement a small local worker-pool loop in the service that needs it, sized by the config constant (`HARNESS_CONCURRENCY_ANTHROPIC_API`, `HARNESS_CONCURRENCY_CLAUDE_CODE`; full list 02 §6.7). Extract to `utilities/helpers/` only when a second service needs it.
- No `await` inside loops over DB rows that could be one query (N+1). Use `inArray` or a join.
- Timeouts: `AbortSignal.timeout(ms)`; combine with the job signal through `AbortSignal.any([ctx.signal, AbortSignal.timeout(ms)])`.
- Sleep: `import { setTimeout as delay } from "node:timers/promises"; await delay(ms, undefined, { signal });`.
- File I/O in services and the worker uses `node:fs/promises`. Sync `fs` is allowed only in scripts and once at boot.
- Never block the event loop longer than ~1 s in the worker (BullMQ lock renewal). Pixel diffing of very large images runs per component, sequentially, with `await` points between components.
- Process-level handlers in `app.ts`/`worker.ts` (04 §9.11), installed at the start of boot: `unhandledRejection` and `uncaughtException` → `logger.fatal` → graceful shutdown with exit 1; `SIGINT`/`SIGTERM` → graceful shutdown bounded by `SHUTDOWN_TIMEOUT_MS`; a second signal forces exit 1.

#### 5.9.2 Child processes

- Only `execFile` / `spawn` from `node:child_process`, with the command and an **argument array**. `exec`, `execSync` and `shell: true` are lint errors.
- Always: `cwd` explicit, a `timeoutMs` (required by `runProcess`; git uses `GIT_DEFAULT_TIMEOUT_MS` / `GIT_FETCH_TIMEOUT_MS`), an output cap (`CHILD_PROCESS_MAX_BUFFER_BYTES` = 10 MiB default; git `GIT_MAX_BUFFER_BYTES`), `signal` when a job signal exists.
- Environment (00 §14.5): start from `CHILD_PROCESS_BASE_ENV` (02 §6.7), an allow-list snapshot of `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LANGUAGE`, `LC_*`, `TZ`, `TMPDIR`/`TMP`/`TEMP`, `TERM`, `SSH_AUTH_SOCK`, proxy and CA variables and `XDG_*`, then add explicit call-specific values (`GIT_TERMINAL_PROMPT=0`, `NODE_ENV=development` for Vite, …). Never pass `process.env` through (only `config-consts` may read it anyway). `DATABASE_URL`, `REDIS_URL`, `PRVISION_SECRET_KEY`, `NODE_OPTIONS` and `GIT_*` can never reach a child. `ANTHROPIC_*`/`CLAUDE_*` reach only the Claude Code child, through `AI_CLAUDE_CODE_PARENT_ENV` (05).
- User-influenced arguments (branch names, refs, paths) are validated first: refs match `^[A-Za-z0-9._/-]+$`, do not start with `-`, do not contain `..`; pass `--` before path arguments to git; resolve paths and assert they are inside the expected root (`isPathInside(root, candidate)`).
- Every child runs in its own process group (`detached: true`) and is killed as a group (`SIGTERM`, then `SIGKILL` after `PROCESS_KILL_GRACE_MS`) on timeout or abort, so grandchildren (`git-remote-https`, `ssh`, Vite workers) die too. `runProcess` does this; long-lived children (10's Vite host) must do the same.
- Log a label (`"git fetch"`), exit code and duration at `debug` — never argv, env or stdin (they can contain tokens or patches); log non-zero exit at `warn` with `exitCode` and the first 2 000 chars of **redacted** stderr.

#### 5.9.3 `runProcess` (signature fixed here, implemented in 04 `utilities/helpers/process.ts`, algorithm 04 §9.6)

```ts
export interface RunProcessOptions {
  cwd: string;
  env?: Readonly<Record<string, string>>;   // default CHILD_PROCESS_BASE_ENV (never raw process.env)
  timeoutMs: number;                        // required: no unbounded children
  maxBufferBytes?: number;                  // per stream; default CHILD_PROCESS_MAX_BUFFER_BYTES
  input?: string | Buffer;                  // written to stdin
  allowedExitCodes?: readonly number[];     // default [0]
  signal?: AbortSignal;
  logLabel?: string;                        // e.g. "git diff"; argv is never logged
}
export interface ProcessResult { stdout: string; stderr: string; exitCode: number; durationMs: number; }
export type ProcessErrorKind = "spawn_failed" | "timeout" | "aborted" | "max_buffer" | "non_zero_exit";
export class ProcessError extends Error {
  constructor(message: string, readonly kind: ProcessErrorKind, readonly command: string,
    readonly exitCode: number | null, readonly signalName: NodeJS.Signals | null,
    readonly stdout: string, readonly stderr: string, readonly durationMs: number, options?: { cause?: unknown });
}
export async function runProcess(command: string, args: readonly string[], options: RunProcessOptions): Promise<ProcessResult>;
```

```ts
// Good
const { stdout } = await runProcess("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], {
  cwd: repoPath, timeoutMs: GIT_DEFAULT_TIMEOUT_MS, signal,
});

// Bad
execSync(`git rev-parse ${ref}`);                             // shell string, injection, no timeout
execFile("git", ["log"], { shell: true, env: process.env });  // shell + leaks every secret
```

Git itself is never called through `runProcess` directly by feature code: use 04's `GitClient`, which adds the
hardening options of 04 §9.5.

### 5.10 Configuration and environment

- `process.env` is read only in `src/config-consts/**` and `src/utilities/helpers/env.ts` (architecture check). `helpers/env.ts` is imported only by `config-consts`.
- Everything else imports constants from the `config-consts` barrel: `import { APP_PORT, DATABASE_URL } from "../config-consts";`.
- **Reading config never throws.** Optional env with a default → eager constant (`APP_PORT`). Required env (`DATABASE_URL`, `REDIS_URL`, `PRVISION_SECRET_KEY`) → eager string that is `""` when unset. A malformed integer is `NaN`. `validateConfig()` (04 §6.2) reports every problem at once, at boot of the API and the worker and in `npm run validate:config`, before anything connects.
- Non-secret tunables (timeouts, limits, names) are source-controlled constants with a JSDoc line, not env variables (Uply's `config-consts` philosophy). Adding a new env variable is a contract change (00 §4).
- Values listed in 00 must match exactly. **02 §6.7 is the single consolidated list** of every constant, value and unit (00 §14.8). A sheet that needs a new constant or a different value requests it ("Contract changes requested"); it never defines a tunable locally.
- Test-only variables (00 §14.10: `PRVISION_IT_RENDER`, `PRVISION_IT_AI`, `PRVISION_INTEGRATION`, `PRVISION_TEST_DATABASE_URL`, and sheet 14's others) are read by test files directly, never by `config-consts` (except `PRVISION_TEST_LOG_STDOUT` → `LOG_TEST_STDOUT`), and are ignored by `validateConfig()`.

### 5.11 Drizzle and Postgres practices

Schema (single file `backend/src/database/schema.ts`, sheet 03):

- Every table: `id: serial("id").primaryKey()`, `createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()`, `updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())` (except append-only `visualization_console_events`: no `updated_at`).
- Soft-delete tables add `isDeleted: boolean("is_deleted").notNull().default(false)`.
- All timestamps `timestamptz`. The pg pool sets `options: "-c timezone=UTC"` (Uply). Views serialize with `.toISOString()`.
- Enum-valued columns: `text("status", { enum: VISUALIZATION_STATUS_VALUES }).notNull()` **plus** a CHECK built from the same tuple. drizzle-kit does not inline bound parameters in DDL (verified: `sql\`${col} in (${values})\`` produces `in ($1, $2)` in the migration), so CHECKs use 03's `sqlLiteralList()` / `checkIn()` / `checkInOrNull()` helpers (03 §6.1), the only allowed `sql.raw`; `sqlLiteralList` rejects anything but `^[a-z0-9_]+$`:

```ts
// (t) => [check("visualizations_status_check", checkIn(t.status, enumValues(VisualizationStatus)))]
```

- Table extras use the array form: `(t) => [index(...).on(...), uniqueIndex(...).on(...).where(sql\`${t.isDeleted} = false\`), check(...)]`.
- Indexes are explicit and justified by a query: every FK column used in a `where`/`join`, every list ordering (`(repository_id, created_at)`), partial unique indexes for "unique among non-deleted".
- Foreign keys always declare `onDelete`: child rows that cannot exist alone → `cascade` (`visualization_components`, `visualization_console_events`); references to soft-deleted parents → `restrict` (visualizations → repositories; repositories are soft-deleted, never hard-deleted while referenced).
- jsonb columns are typed: `jsonb("global_style_paths").$type<string[]>().notNull().default(sql\`'[]'::jsonb\`)`.
- Numerics: `numeric("diff_pixel_ratio", { precision: 8, scale: 6, mode: "number" })` (returns `number`, verified with drizzle-orm 0.45). Never use `float` for ratios that are compared. Counts are `integer`. `count()` returns a number.
- Long text (code diffs, harness source, summaries) is `text`; size limits are enforced in services by constants (02 §6.7), not by `varchar(n)`.

Access:

- `QueryHandler` is the default for CRUD (guidelines §5). It applies `isDeleted = false` automatically on soft-delete tables and stamps `updatedAt`. Its `delete` is a soft delete when the table has `isDeleted` (Uply behaviour).
- Direct Drizzle in a service is allowed for joins, aggregates, ordering-heavy lists, keyset/cursor reads and bulk upserts, with the comment `// Direct Drizzle: <reason>` (checked by `check:architecture`). Never in controllers.
- Lists always select explicit columns, are paginated (`DEFAULT_PAGE_SIZE` 20, `MAX_PAGE_SIZE` 100) and ordered deterministically (`created_at desc, id desc`).
- Use `.returning()` instead of insert-then-select.
- Multi-row or multi-table writes that must be atomic run in a transaction (`DrizzleDb.transaction`, 04 §9.2), and the transaction handle is passed down; never mix `tx` and the global db inside one unit; inside the transaction every non-200 `ApiResponse` is turned into a throw (Postgres aborts the transaction on the first error and a normal return would commit partial work); no network or child-process `await` inside a transaction:

```ts
// Direct Drizzle: transaction spans visualization update + component inserts; QueryHandler is bound per instance.
await DrizzleDb.transaction(async (tx) => {
  const queryHandler = new QueryHandler(tx);
  const updated = await queryHandler.update({ status: VisualizationStatus.ANALYZING }, { id }, Table.VISUALIZATIONS);
  if (updated.status !== 200) {
    throw new Error(`Visualization ${id} update failed (${updated.status})`); // rolls back
  }
  await tx.insert(schema.visualizationComponents).values(rows);
});
```
- `QueryHandler` resolves `Table` values (snake_case SQL names, 00 §14.3) through `database/table-registry.ts`; never index the schema module by name.
- Every session runs with `timezone=UTC`, `statement_timeout=30s`, `idle_in_transaction_session_timeout=60s` (03 §7.1).

- `sql` templates only with bound parameters (`sql\`${column} = ${value}\``). `sql.raw` outside `schema.ts` is a lint error.
- Migrations: only `npm run db:generate` (drizzle-kit) produces them. Never edit an applied migration. Commit `schema.ts`, regenerated `models/` and the new migration together. CI-style drift scripts (`drizzle:drift`, `models:drift`) must pass.
- Types: services use generated models (`RepositoryModel`) for model-in/model-out flows and `typeof schema.table.$inferSelect` for direct-Drizzle reads. No hand-written row interfaces that duplicate the schema.

### 5.12 Express 5 practices

Middleware order in `app.ts` (04 §5.1 implements it; this is the required order):

1. `app.disable("x-powered-by")`; `app.set("trust proxy", false)`; `app.set("query parser", "simple")`.
2. `requestContextMiddleware`: request id (`X-Request-Id`, echoed when it matches `^[A-Za-z0-9._-]{1,64}$`), access log `http.request.completed` (method, path without query, status, durationMs; never bodies).
3. `LocalAuthMiddleware.guardHost`: the `Host` header must be exactly `localhost:<PORT>` or `127.0.0.1:<PORT>` (00 §14.5, DNS-rebinding defence) → otherwise 403 `forbidden_origin`.
4. `helmet({ crossOriginResourcePolicy: { policy: "same-site" }, contentSecurityPolicy: false })` — the default `same-origin` CORP would block `<img src="http://localhost:3100/artifacts/...">` inside the UI on port 4210.
5. `cors({ origin: [FRONTEND_URL, <its localhost/127.0.0.1 twin>], credentials: false, methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "X-Request-Id"], maxAge: 600 })`. No wildcard, no reflected origin.
6. `express.json({ limit: JSON_BODY_LIMIT })` (`"1mb"`). No `urlencoded`, no cookie parser.
7. `AuthContext.middleware` — **after** `express.json`: body-parser resumes the request from the socket's async context, so an AsyncLocalStorage store opened earlier is lost in handlers of requests with a body.
8. `app.use(ARTIFACTS_ROUTE, requireLocal, artifactPathGuard, express.static(artifactsDir, { index: false, dotfiles: "deny", fallthrough: false, redirect: false }))` with `Cache-Control: private, no-cache` (images can be rewritten during harness repair, so never `immutable`). Express 5 uses path-to-regexp v8: a bare `*` route no longer works (`/artifacts/*` must be written `/artifacts/*splat`); mounting with `app.use` avoids it.
9. `registerRoutes(app, deps)`; every `/api` route carries `requireLocal`, which rejects state-changing requests whose `Origin` is present and not an allowed frontend origin (00 §14.5) → 403 `forbidden_origin`.
10. 404 handler via `ResponseHandler` (`"Resource not found"`, 404, `not_found`).
11. Terminal error handler `(err: unknown, req, res, next)` → body-parser errors map to 400 `validation_failed` / 413 `payload_too_large`, static-file 403/404 map to 404; everything else → `logger.error` → 500 `internal_error` (body never includes a stack or `err.message`).

Listen with `http.createServer(app).listen(APP_PORT, APP_HOST)` and await the `listening`/`error` events (04 §5.1); `EADDRINUSE` → fatal log with a hint, graceful shutdown, exit 1.

Express 5 specifics agents trip on:

- Rejected promises from async handlers are forwarded to the error middleware automatically; controllers still catch (guidelines) so the envelope is consistent.
- `req.query` is a read-only getter; never assign to it. Validate `req.query` through a query DTO.
- `req.body` is `undefined` when no body was sent; `Validation.compileJsonData` returns `{}` for falsy or non-object input.
- Route params are strings; convert with the `IdParamDTO` (positive integer) — never `Number(req.params.id)` unchecked.
- Removed APIs: `app.del`, `res.send(status, body)`, `req.param()`. Use `res.status(x)` only inside `ResponseHandler`.

Routes stay one explicit file (`routes/index.ts`) with a typed `RouteDependencies` object and `.bind(controller)`, exactly as guidelines §4.2 and Uply `routes/index.ts`.

### 5.13 Queue and worker practices

- BullMQ wiring lives only in `utilities/services/queue-service.ts` (04 §9.4). Services call `QueueService.enqueueVisualization(id)`; nothing else imports `bullmq`.
- Queue names, job name, job id format, retention, concurrency, lock and cancel settings come from `queue.config.ts` (values = 00 §10, §14.6; list in 02 §6.7).
- Redis connections (04 §9.3): BullMQ workers use `maxRetriesPerRequest: null` (required); the queue producer and the shared command client use `maxRetriesPerRequest: 1` so HTTP requests fail fast while Redis is down.
- The processor is injected by `worker.ts` and receives one object `{ visualizationId, jobId, signal }` (00 §14.6); it is thin: `(job) => new VisualizationWorkerService().run(job)`; all state changes go through services.
- Worker options: `concurrency: 1`, `lockDuration: 300000`, `maxStalledCount: 0` (a stalled job fails and is never re-run; 07's boot recovery marks the row). On shutdown the active job is aborted with reason `"shutdown"`, then `worker.close()` runs before Redis and the pg pool close.
- Jobs are idempotent by `jobId = viz-<id>`; the worker must tolerate a job whose visualization row is already terminal or deleted (log `warn`, return).

### 5.14 Angular practices

#### 5.14.1 Folder structure (00 §12)

```text
frontend/src/
  main.ts  index.html  styles.scss
  environments/environment.ts  environment.production.ts
  app/
    app.config.ts  app.routes.ts  app.component.ts
    layouts/main-layout/
    core/
      services/        api.service.ts, notification.service.ts, theme.service.ts, confirm-dialog.service.ts, …
      models/          *.model.ts (mirror 00 §9 exactly)
      interceptors/    error.interceptor.ts
      constants/       polling.constants.ts, pagination.constants.ts
      utils/           *.util.ts
    shared/
      components/      status-pill, data-grid, empty-state, loading-spinner, confirm-dialog, generic-popup, …
      pipes/           relative-time.pipe.ts (RelativeTimePipe, `relativeTime`), …
    features/
      repositories/    repository-list/, repository-detail/, components/
      visualizations/  visualization-list/, visualization-detail/, components/
      settings/        settings-page/
```

`core` = singletons and pure TS; `shared` = reusable presentational components and pipes (no `ApiService` injection); `features` = routed pages and their private components. A feature never imports from another feature; promote to `shared` instead.

#### 5.14.2 Components

- Standalone only (Angular 19 default; do not write `standalone: true`, the lint rule enforces it). No NgModules.
- `changeDetection: ChangeDetectionStrategy.OnPush` on every component.
- State in signals: `signal`, `computed`; inputs/outputs via `input()`, `input.required()`, `output()`, `model()`. `effect` only for side effects that leave Angular (DOM APIs, `localStorage`, theme application) — never to copy one signal into another (use `computed`).
- `inject()` for every dependency; no constructor parameters.
- Built-in control flow (`@if`, `@for (…; track item.id)`, `@switch`, `@defer` for heavy panels). `track` always uses a stable id, never `$index` for server data.
- Template expressions call only signals and pure getters; no method calls with side effects; no `any` in templates.
- Class bindings instead of `NgClass`: `[class.dd-pill--success]="isSuccess()"` or `[class]="pillClass()"`.
- Components are `protected` for template-only members, `readonly` for signals and injected services.
- Images: `NgOptimizedImage` is not used for artifact images (dynamic, unknown dimensions); always set `width`/`height` from `imageWidth`/`imageHeight` and `alt`.

```ts
// Good
@Component({
  selector: 'app-status-pill',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="dd-pill" [class]="pillClass()">{{ label() }}</span>`,
})
export class StatusPillComponent {
  readonly status = input.required<string>();
  protected readonly pillClass = computed(() => pillClassFor(this.status()));
  protected readonly label = computed(() => formatPillLabel(this.status()));
}

// Bad (Uply's current shape; convert when copying)
@Component({ selector: 'app-status-pill', standalone: true, imports: [CommonModule],
  template: `<span class="dd-pill" [ngClass]="pillClass">{{ label }}</span>` })
export class StatusPillComponent {
  @Input() status = '';
  get pillClass(): string { … }
}
```

When copying a Uply component (sheet 12): convert `@Input`/`@Output` to signal APIs, getters to `computed`, `CommonModule`/`NgClass`/`*ngIf`/`*ngFor` to class bindings and control flow, constructor injection to `inject()`, add OnPush. Keep markup, CSS classes and visual output identical.

#### 5.14.3 Services, HTTP and RxJS vs signals

- `ApiService` (`core/services/api.service.ts`) is the only class that uses `HttpClient`. One typed method per route in 00 §9, returning `Observable<View>`; base URL `environment.apiBaseUrl`. No `map` reshaping beyond what the view contract needs (views already match 00 §9).
- Artifact URLs: `environment.artifactBaseUrl + component.baseImageUrl` via one helper `artifactUrl(path: string | null): string | null` in `core/utils/artifact-url.util.ts`.
- RxJS is for **asynchronous streams**: HTTP, polling (`exhaustMap`), debounced input, cancellation of superseded requests (`switchMap`). Signals are for **state** read by templates. Convert at the edge with `toSignal(...)` or by subscribing with `takeUntilDestroyed(this.destroyRef)` and writing into a signal.
- Polling (00 §12: detail every 2 s, console every 1.5 s, stop on terminal or destroy):

```ts
private readonly destroyRef = inject(DestroyRef);

private startPolling(id: number): void {
  timer(0, VISUALIZATION_POLL_MS)
    .pipe(
      // exhaustMap, not switchMap: a slow response is never cancelled and requests never overlap;
      // ticks that arrive while a request is in flight are skipped.
      exhaustMap(() => this.api.getVisualization(id)),
      takeWhile((view) => !isTerminal(view.status), true),
      takeUntilDestroyed(this.destroyRef),
    )
    .subscribe({
      next: (view) => this.visualization.set(view),
      error: () => this.loadFailed.set(true),
    });
}
```

- Never nest `subscribe` inside `subscribe`; never leave a subscription without `takeUntilDestroyed`, `take(1)` or completion by HTTP.
- Errors: the functional `errorInterceptor` (`core/interceptors/error.interceptor.ts`) maps `HttpErrorResponse` to `ApiError { status, message, reason }` using the envelope in §5.7.1 (`error` string or string[] → message, `error_reason` → reason; 00 §14.2 — no Uply raw-format fallback is needed) and shows it through `NotificationService.error(...)` unless the request opted out with an `HttpContext` token `SUPPRESS_ERROR_TOAST`. Components handle `error_reason` codes they care about (e.g. `working_tree_clean`) and set `SUPPRESS_ERROR_TOAST` for those calls. No 401 logout logic (no auth).
- `NotificationService` is Uply's (`show/success/error/info/warn`). Never `window.alert`, never raw `MatSnackBar`.

#### 5.14.4 Forms

- Typed reactive forms via `NonNullableFormBuilder`: `private readonly fb = inject(NonNullableFormBuilder); readonly form = this.fb.group({ name: ['', [Validators.required, Validators.maxLength(120)]] });`.
- Read with `form.getRawValue()` (fully typed); never `form.value` for submission.
- Submit: if invalid → `form.markAllAsTouched()` and return; set `saving` signal true; disable the submit button while saving; re-enable in `finalize`.
- Map server `validation_failed` messages to a form-level error text; field-level errors use `<mat-error>`.
- Secrets (GitHub token, API key) are write-only inputs: never prefilled, `type="password"`, `autocomplete="new-password"` (browsers ignore `off` on password fields and would offer saved passwords), cleared after save; show `hasGithubToken`/`hasAnthropicApiKey` state instead. Sending `""` clears a stored secret and omitting the field keeps it (00 §14.4).
- No template-driven forms (`ngModel`) in new code.

#### 5.14.5 Accessibility

- Every interactive element is a `<button type="button">`, `<a routerLink>` or a Material control; no click handlers on `div`/`span`.
- Icon-only buttons have `aria-label` and a `matTooltip` with the same text.
- Status is never conveyed by colour alone: status pills carry text; diff overlays have a legend.
- Images: `alt` describes what is shown (`"Head render of CartSummary"`). Decorative images `alt=""`.
- Focus: dialogs use Material dialog focus trapping; after closing, focus returns to the trigger (Material default). Live progress (console panel) uses `aria-live="polite"` on the container, not on each line.
- Respect `prefers-reduced-motion` (no animated diff toggles when set).
- Contrast follows Uply tokens; do not introduce new text colours.

#### 5.14.6 Styling (Uply parity)

- Global styles are Uply's `tenant-frontend/src/styles.scss` copied by sheet 12 (Tailwind 4 via `@use 'tailwindcss'`, `@theme` tokens, `dd-*` classes, Material overrides, Manrope + Material Symbols Rounded fonts) and Material's `azure-blue` prebuilt theme as in Uply's `angular.json`.
- Layout and spacing: Tailwind utilities in templates. Colours: only CSS variables/tokens already defined by Uply (`var(--color-primary)`, `var(--color-surface)`, `dd-pill--*`, …). No hex colours in component styles.
- Component `.scss` stays under the Uply budget (warn 4 kB, error 8 kB). Prefer utilities and global `dd-*` classes; no `::ng-deep`; no `!important` except to beat Material in the global stylesheet (Uply already does this).
- New visual patterns (diff viewer, before/after slider) are built from existing tokens and documented in sheet 13.
- `ThemeService` (light/dark shell) is Uply's, minus tenant branding.

### 5.15 Testing standards

Backend (`node:test` + `node:assert/strict`):

- Location: `tests/backend/<area>/<subject>.test.ts`, areas: `config`, `utilities`, `middleware`, `controllers`, `services/<feature>`, `pipeline`, `integration`. Helpers in `tests/backend/helpers/` (`test-context.ts` with `runWithAuthContext` and `patchStaticMethod`, copied from Uply by 04; fixtures builders added by the sheet that needs them).
- Imports from the backend use relative paths into `backend/src` (Uply style: `../../../backend/src/...`).
- Run: `npm test --prefix backend` = `node --test --test-reporter=spec --test-concurrency=1 --test-force-exit -r ts-node/register/transpile-only -r ../tests/backend/helpers/setup.ts "../tests/backend/**/*.test.ts"` (00 §14.10; 02 §6.9.1). The preload `tests/backend/helpers/setup.ts` (02 placeholder, 14 owns) sets `NODE_ENV=test`, fixed fake `DATABASE_URL`/`REDIS_URL`/`PRVISION_SECRET_KEY` and a per-process temp `PRVISION_DATA_DIR` before any backend module loads, so tests never read the developer's `.env` or `~/.prvision`. `--test-force-exit` ends the run despite a leaked handle (still a bug to fix).
- Log assertions subscribe to `logTestStream` (04 §9.10; 00 §14.10); pino child loggers cannot be patched after import.
- Test names: `"<Class>.<method> <expected behaviour> [when <condition>]"`, e.g. `"RepositoriesService.create returns 400 not_git_repo when the path has no .git"`.
- Unit tests never touch real Postgres, Redis, network, GitHub, Anthropic or Chromium. Replace `queryHandler`, clients and providers by assigning stubs (`(service as unknown as { queryHandler: unknown }).queryHandler = { … }`) or `patchStaticMethod`; always restore in `t.after` / `finally`.
- Filesystem and git tests use a temp dir from `fs.mkdtemp(path.join(os.tmpdir(), "prvision-test-"))`, removed in `after`.
- Integration tests (real Postgres/Redis from docker compose, real git, real Chromium) live in `tests/backend/integration/` and skip themselves unless their flag is set (00 §14.10): `PRVISION_INTEGRATION=1` (umbrella; enables render ITs), `PRVISION_IT_RENDER=1`, `PRVISION_IT_AI=1`, `PRVISION_TEST_DATABASE_URL=<…_test db>`. Example: `test("…", { skip: process.env.PRVISION_INTEGRATION !== "1" }, async () => { … })`. `npm run test:it --prefix backend` runs only them.
- Config constants are evaluated once per test-file process, after the preload. A test that needs another config value passes it explicitly (`collectConfigValidationErrors(overrides)`, constructor options such as `new ArtifactStore(tempDir)`, `Encryption.setKeyForTesting`) instead of mutating `process.env` after import.
- Every service method: success path, each expected-failure `error_reason`, and the unexpected-error 500 path. Every pipeline step: success, per-component failure captured (not thrown), fatal `PipelineStepError`, abort respected.
- Never delete, skip or weaken a test to make the gate pass.

Frontend (Karma + Jasmine, Uply parity):

- `*.spec.ts` next to the file; `npm test --prefix frontend` is a single headless run (`ng test --watch=false --browsers=ChromeHeadless`, through 02's wrapper that points `CHROME_BIN` at Playwright's Chromium when unset); `npm run test:watch --prefix frontend` keeps watch mode (00 §14.10).
- Services: `provideHttpClient()`, `provideHttpClientTesting()`, `HttpTestingController` to assert URL/method/body.
- Components: `TestBed.configureTestingModule({ imports: [Component], providers: [...] })`, set inputs with `fixture.componentRef.setInput('name', value)`, then `fixture.detectChanges()`; query by role/text, not by CSS class where possible.
- Polling: `fakeAsync` + `tick(VISUALIZATION_POLL_MS)`; assert polling stops on a terminal status and on destroy.

### 5.16 Git and commit conventions

- Conventional Commits, as used in Uply's history (`docs:`, `ci:`, `chore(backend):`, `build(backend):`). Types: `feat`, `fix`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`, `perf`. Scopes: `backend`, `worker`, `db`, `frontend`, `tooling`, `specs`.
- Subject ≤ 72 chars, imperative, no trailing period: `feat(backend): add repositories service and routes (sheet 06)`.
- Branch per sheet: `sheet/<NN>-<slug>` (e.g. `sheet/06-repositories-github`). Do not commit to `main` directly.
- Commit `schema.ts`, regenerated `models/`, and the new migration in one commit.
- Commit lockfiles (`package-lock.json` in root, `backend/`, `frontend/`) whenever dependencies change.
- Never commit `.env`, anything under the data dir, `dist/`, `.angular/`, coverage, `.prvision-harness/`.
- AI-authored commits end with the co-author trailer configured for the session.
- Before every commit: `npm run verify` passes (§5.17).

### 5.17 Definition of Done (applies to every sheet; each sheet's acceptance list adds to it)

- [ ] Every file in the sheet's inventory exists at the stated path with the stated responsibility; no extra feature files outside it (helpers added must be listed in the sheet's PR description).
- [ ] Names, paths, enums, table/column names, routes, view shapes and `error_reason` codes match 00 exactly (or a "Contract changes requested" entry exists).
- [ ] `npm run verify` from the repo root passes: backend `format:check`, `typecheck`, `lint` (0 warnings), `check:architecture`, `test`, `build`; frontend `format:check`, `lint`, `build`, `test`.
- [ ] No `any`, no `!` non-null assertions in `src`, no `console.*` outside loggers/scripts, no `eslint-disable` without `-- reason`, no `process.env` outside config.
- [ ] Controllers: validate → map → service → `ResponseHandler`. Services return `ApiResponse` (HTTP) or typed results / `PipelineStepError` (pipeline).
- [ ] Every new HTTP input shape has a DTO; every route is in `routes/index.ts`.
- [ ] Schema changes: migration generated by drizzle-kit and committed with models; `drizzle:drift` and `models:drift` clean; `npm run db:migrate` applies on an empty database.
- [ ] Logs use `logger` with `event`; no secrets in logs, console events, error messages or test snapshots.
- [ ] Child processes go through `runProcess` (or `execFile`/`spawn` with arrays, timeouts, allowlisted env).
- [ ] Tests listed in the sheet exist with the named cases and pass; no test was skipped or weakened.
- [ ] Frontend: standalone + OnPush + signals + `inject()` + control flow; strict templates compile; a11y lint clean; visuals use Uply tokens/classes.
- [ ] The manual check in the sheet's acceptance list was performed (e.g. `npm run dev`, open `http://localhost:4210`, exercise the feature) and the result noted in the PR/commit description.

## 6. Error handling and edge cases (applying these standards)

| Situation | Rule |
|---|---|
| A lint rule blocks correct code | Prefer restructuring. Otherwise a single-line `eslint-disable-next-line <rule> -- <reason>`. Never file-wide, never without a reason (lint enforces both). |
| A third-party type is `any` (e.g. untyped JSON from an SDK) | Assign to `unknown` immediately and narrow with a type guard or ajv/class-validator. |
| ESM-only dependency fails to load under `require(esm)` (top-level await → `ERR_REQUIRE_ASYNC_MODULE`) | Use `const mod = await import("pkg")` inside an async function; keep the import in one adapter file. Under `module: nodenext` TypeScript keeps a dynamic `import()` as a real `import()` in CommonJS output. |
| An awaited call rejects with a non-`Error` (abort reason string) | Expected for job-signal aborts (00 §14.6). Use `getErrorMessage`; rethrow unchanged when `signal.aborted`. |
| Copied Uply code fails strict lint | Fix while copying (types, braces, logger, no `!`). Do not add suppressions. |
| A Uply helper uses `console` | Replace with `logger` and an `event` name. |
| Need a constant not in 02 §6.7 | Add it to the matching `config-consts/*.config.ts` with JSDoc (never a module-local tunable, never hardcoded) and list it under your sheet's "Contract changes requested" so 02 §6.7 and its `EXPECTED_NAMES` test are updated. |
| Need a new env variable | Contract change (00 §4); do not add silently. |
| Need a new `error_reason` | List it in your sheet's "Contract changes requested". |
| Unexpected `null` from DB on a "not null" column | Treat as a bug: `throw new Error("Invariant: …")`; the boundary logs it. |
| Timeout inside a pipeline step | Component-level → record failure; stage-level (Vite never starts) → `PipelineStepError`. |
| Abort during cleanup | Cleanup in `finally` must not throw; log cleanup failures at `warn`. |

## 7. Logging / console events

This sheet defines the logging rules (§5.8). It emits no events itself. Each sheet lists its own `event` names (backend logs) and console-event messages (user-facing) in its "Logging / console events" section using the formats fixed in §5.8.

## 8. Security notes

- Server binds `127.0.0.1` only (`APP_HOST`); config-validation (04) refuses non-loopback hosts.
- DNS-rebinding defence (Host must be `localhost:<PORT>`/`127.0.0.1:<PORT>`), Origin check on state-changing requests (00 §14.5), CORS restricted to the frontend origin(s), `helmet` with `same-site` CORP (§5.12).
- Secrets (GitHub token, Anthropic key) are encrypted at rest with `PRVISION_SECRET_KEY` (AES-256-GCM, Uply `Encryption`), never returned by the API (views expose `has*` booleans), never logged (pino redaction + `redactSecrets`), never passed to child processes (env allow-list; the GitHub token reaches git only as a per-call `GIT_CONFIG_*` env value, 04 §9.5).
- Errors to clients: 500 bodies are always the generic `"Internal server error"`; no stack, SQL, path or command output.
- Child processes: argument arrays only, no shell, validated refs and paths, timeouts and buffer caps (§5.9).
- Path traversal: every path built from user or DB input is resolved and checked with `isPathInside(root, candidate)` before use (artifacts, worktrees, harness folder); paths inside a worktree (repository-controlled content, possibly symlinks) are also checked with `isRealPathInside` (04 §9.7).
- SQL: parameterized only; `sql.raw` confined to CHECK literal lists in `schema.ts` with a whitelist regex.
- Rendering executes the target repo's code and Vite config in a Node child context and Chromium: this is inherent (the user's own repo). PRVision never renders a repo the user did not register, and the Claude Code provider runs read-only tools in the head worktree (sheet 05).
- Frontend: Angular's built-in sanitization for any `[innerHTML]` (AI markdown summary); no `bypassSecurityTrust*`.

## 9. Tests

This sheet has no code. Its rules are verified by tests owned elsewhere:

| Test file | Owner | Cases that prove this sheet's rules |
|---|---|---|
| `tests/backend/config/app-config.test.ts` | 02 | defaults match 00 §4; `resolveDataDir` expands `~`; env readers never throw (`NaN` for malformed integers); `CHILD_PROCESS_BASE_ENV` is allow-listed |
| `tests/backend/config/config-consts.test.ts` | 02 | every 02 §6.7 constant exported; `render.config.ts` imports only `node:path` |
| `tests/backend/config/queue-config.test.ts` | 02 | queue values equal 00 §10 and §14.6 |
| `tests/backend/types/pipeline-errors.test.ts` | 02 | `PipelineStepError` keeps `stage`, `userMessage`, `detail`, `code`, `cause`, `name`; re-exported from `visualization-pipeline`; `isPipelineStepError`; `isAbortError` true for the error from `AbortSignal.abort().throwIfAborted()`, false for a `TimeoutError` and for plain `Error` |
| `tests/backend/config/config-validation.test.ts` | 04 | missing/invalid values reported, secrets never echoed, test-only variables ignored |
| `tests/backend/utilities/validation.test.ts` | 04 | tuple narrowing: `[true, null, dto]` / `[false, ApiResponse(400, validation_failed), null]` |
| `tests/backend/utilities/response-handler.test.ts` | 04 | envelope table in §5.7.1 |
| `tests/backend/utilities/logger.test.ts` | 04 | redaction of `REDACT_PATHS` and `redactSecrets` patterns, through `logTestStream` |
| `tests/backend/utilities/process.test.ts` | 04 | non-zero exit rejects `ProcessError` kind `non_zero_exit`; timeout → kind `timeout`; process group killed; env contains none of `PRVISION_SECRET_KEY`, `DATABASE_URL`, `REDIS_URL` |

Lint and architecture rules are proven by running `npm run lint` / `npm run check:architecture` in 02's bootstrap procedure, including the negative checks listed there.

## 10. Acceptance criteria

- [ ] 02 places §5.2–§5.4 configs on disk byte-for-byte (modulo Prettier formatting of the JS config files).
- [ ] With 02's scaffold, `npm run lint --prefix backend` reports an error for each of: `exec` import from `node:child_process`, `shell: true`, `res.json(...)` in a controller, `sql.raw` outside `schema.ts`, an un-awaited promise, a `void promise`, an exported function without a return type, `console.log` in `src/services`, an `eslint-disable` without description, and any file under `backend/harness-templates/` is not linted.
- [ ] `ResponseHandler` emits the 00 §14.2 envelope (`{ status, data }` / `{ status, error, error_reason }`) and 04's `response-handler.test.ts` proves the §5.7.1 table.
- [ ] `npm run check:architecture` fails for a `process.env` read in `src/services` and for an import of `utilities/helpers/env` outside `config-consts`, and passes on the clean scaffold.
- [ ] Frontend lint fails for a component without OnPush, an `@Input()` decorator, constructor injection, `*ngIf`, a `<button>` without `type`.
- [ ] `backend/src/types/pipeline-errors.ts` compiles under §5.2.1 and its test passes.
- [ ] Every later sheet's acceptance list includes the §5.17 Definition of Done.

## 11. Contract changes requested

1. **`Table` enum values.** Resolved — 00 §14.3 (snake_case values kept; `QueryHandlerDrizzle` resolves them through `database/table-registry.ts`). The camelCase request is withdrawn.
2. **Node minimum 22.12, `.nvmrc` 24.** Resolved — 00 §14.1.
3. **HTTP wire format.** Resolved — 00 §14.2 (the envelope is on the wire; §5.7.1 updated).
4. **`types/pipeline-errors.ts` and scaffold materialization of enums/types.** Resolved — 00 §14.3, §14.7.

Open: none.
