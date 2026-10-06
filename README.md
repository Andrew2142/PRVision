# PRVision

PRVision is a local-first developer tool. It turns a GitHub pull request, a local branch, or uncommitted
working-tree changes into a visual review: for every UI component the change touches it shows the component
rendered **before** (base) and **after** (head). It does not run your app: each changed component is rendered in isolation in headless
Chromium, through your repo's own Vite, using a render harness written by AI. The same harness renders base and
head, so differences come only from the component code.

> Screenshot placeholder: the visualization detail screen goes here once sheet 13 lands.

## Requirements

- Node 22.12+ (24 recommended; see `.nvmrc`) and npm 10+
- git 2.36+
- Docker with Compose v2 (`docker compose`)
- About 1 GB of disk for Chromium and the container images
- Linux or macOS

## Quick start

```bash
nvm use            # Node 24 from .nvmrc
npm run setup      # install, .env, Postgres + Redis, migrations, Chromium, data dir
npm run dev        # backend :3100, worker, frontend :4210
```

Open <http://localhost:4210>. In **Settings**, add a GitHub fine-grained token and choose an AI provider. In
**Repositories**, register a local clone of a Vite + React project.

## Scripts

| Script | What it does |
|---|---|
| `npm run setup` | Prereq check, install, `.env`, infra up, migrate, Chromium, data dir. Idempotent. |
| `npm run dev` | Frees 3100/4210, checks `.env`, starts infra, migrates, runs backend + worker + frontend |
| `npm run infra:up` / `infra:down` | Start / stop Postgres and Redis |
| `npm run infra:reset` | **Deletes** all Postgres and Redis data |
| `npm run db:migrate` | Apply Drizzle migrations |
| `npm run verify` | Format check, typecheck, lint, architecture check, tests and build (backend and frontend) |
| `npm run build` / `lint` / `format` / `test` | Fan out to `backend/` and `frontend/` |
| `npm run fixture:create` | Create the sample React fixture repo (sheet 14) |

## How it works

- **Prepare:** PRVision creates git worktrees for base and head under the data dir and symlinks your `node_modules`.
- **Analyze:** it finds the components the change touches, directly or through changed imports.
- **Generate harnesses:** AI writes a small render harness per component (props, fixtures, providers, mocks).
- **Render:** real code renders the pixels: both sides go through your repo's own Vite in headless Chromium.
- **Diff and summarize:** pixel and structural diffs, then an AI summary of what changed and what to check.

AI writes the harness; real code renders the pixels.

## Data and safety

- Data dir (`~/.prvision` by default): `worktrees/<id>/{base,head}`, `artifacts/<id>/<component>/{base,head,diff}.png`,
  `fixtures/`. Created with mode 0700.
- Your working copy is never modified. PRVision only creates its own worktrees and `refs/prvision/*` refs.
- The GitHub token and Anthropic API key are encrypted at rest with `PRVISION_SECRET_KEY` and never returned by the API.
- The backend binds `127.0.0.1` only; Postgres and Redis ports bind to `127.0.0.1` only.


## Repository layout and specs

```text
PRVision/
  package.json  docker-compose.yml  .env.example  README.md  CLAUDE.md
  scripts/                 check-prereqs.mjs, clean-dev-ports.mjs
  tools/                   fixture tooling (sheet 14)
  backend/                 Express API + BullMQ worker (src/, scripts/, harness-templates/)
  frontend/                Angular 19 app
  tests/backend/           node:test suites and helpers
  tests/fixtures/          test fixtures
  docs/specs/              build specs 00–14
```

The build specs are in [`docs/specs/`](docs/specs/); start with `00-overview-and-contracts.md`.
