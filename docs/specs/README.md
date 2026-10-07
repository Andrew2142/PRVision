# PRVision Build Specs

These sheets describe the full PRVision prototype build. Each sheet is sized to be handed to one build agent.

## How to assign work

1. Every agent reads, in order: `00-overview-and-contracts.md`, `01-engineering-standards.md`, `../ARCHITECTURE_GUIDELINES.md`, then its own sheet.
2. Agents code against the contracts in sheet 00 and stub neighbours in tests; they do not wait for other sheets' implementations.
3. An agent may not change a contract in sheet 00 on its own. It raises the change with the lead, who updates 00 first.
4. A sheet is done when every item in its "Acceptance criteria" is checked and the Definition of Done in sheet 01 holds.

## Sheets and build waves

| Wave | Sheets | Can run in parallel |
|---|---|---|
| 1 | 02 Repository scaffold and tooling | — |
| 2 | 03 Database, 04 Backend core, 12 Frontend foundation, 14 (fixture repo + test helpers) | yes |
| 3 | 05 Settings + AI providers, 06 Repositories + GitHub, 07 Visualizations orchestration, 13 (Settings + Repositories screens) | yes |
| 4 | 08 Change analysis, 09 Harness generation | yes |
| 5 | 10 Render engine, 11 Diff + structural + summary, 13 (Visualization screens) | yes |
| 6 | 14 Full test catalogue + manual E2E QA | — |
| 7 | 15a–15f Angular support (see sheet 15 §0 for the split and dispatch order) | 7a yes, 7b after 7a |
| 8 | 16a–16l Harness library, states, live mode, export/import (see sheet 16 §0 for the split and dispatch order) | 8a (16a) alone; 8b (16b, 16c, 16e, 16h, 16l fixtures) yes; 8c (16d), 8d (16f), 8e (16g) one at a time; 8f (16i, 16j live) yes; 8g (16k export/import); 8h (16l integration tests, QA) last |

Sheet 01 is a reference for every wave, not a build task.

| Sheet | File |
|---|---|
| 00 | [Overview and shared contracts](00-overview-and-contracts.md) |
| 01 | [Engineering standards](01-engineering-standards.md) |
| 02 | [Repository scaffold and tooling](02-repo-scaffold-and-tooling.md) |
| 03 | [Database schema, migrations and models](03-database-schema-and-models.md) |
| 04 | [Backend core infrastructure](04-backend-core-infrastructure.md) |
| 05 | [Settings and AI providers](05-settings-and-ai-providers.md) |
| 06 | [Repositories and GitHub](06-repositories-and-github.md) |
| 07 | [Visualizations API, orchestration and workspaces](07-visualizations-orchestration.md) |
| 08 | [Change analysis](08-change-analysis.md) |
| 09 | [Harness generation](09-harness-generation.md) |
| 10 | [Render engine](10-render-engine.md) |
| 11 | [Image diff, structural diff and AI summary](11-diff-structural-summary.md) |
| 12 | [Frontend foundation](12-frontend-foundation.md) |
| 13 | [Frontend feature screens](13-frontend-feature-screens.md) |
| 14 | [Testing, fixtures and QA](14-testing-fixtures-and-qa.md) |
| 15 | [Angular support (app roots, analysis, harness, render, structural diff)](15-angular-support.md) |
| 16 | [Harness library, states and live mode](16-harness-library.md) |
