# PRVision agent rules

Read before changing anything: `docs/specs/00-overview-and-contracts.md` (contracts),
`docs/specs/01-engineering-standards.md` (how code is written), `docs/ARCHITECTURE_GUIDELINES.md`
(architecture style), and the spec sheet you are assigned.

## Before declaring work done

Run `npm run verify` from the repo root and make sure it passes. Backend: format check, typecheck,
lint, architecture check, unit tests, build. Frontend: format check, lint, build, tests. Unit tests
need no database. Paste the tail of the output when reporting.

## Rules

- Contracts in 00 are fixed. If one must change, write it under "Contract changes requested"; never diverge silently.
- No `any` (use `unknown` and narrow), no non-null `!` in `src`, no `console.*` outside `utilities/loggers` and scripts.
- `process.env` only in `backend/src/config-consts/**` and `backend/src/utilities/helpers/env.ts`.
- Never add an `eslint-disable` without a `-- reason`. There is no suppressions file and none may be added.
- Direct Drizzle in a service needs a `// Direct Drizzle: <why QueryHandler is insufficient>` comment.
- Child processes only through `runProcess` or `execFile`/`spawn` with argument arrays, timeouts and an env allowlist.
- Never edit an applied migration. Schema change: edit `schema.ts` → `npm run generate:models` →
  `npm run db:generate` → commit schema, models and migration together.
- Never delete, skip or weaken a test or assertion to make the gate pass.
- Never commit `.env`, anything from the data dir (`~/.prvision`), `dist/` or `.angular/`.
