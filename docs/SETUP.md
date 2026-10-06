# Setup reference

## Requirements

- Node 22.12+ (24 recommended; see `.nvmrc`) and npm 10+
- git 2.36+
- Docker with Compose v2 (`docker compose`)
- About 1 GB of disk for Chromium and the container images
- Linux or macOS

## Configuration

`npm run setup:env` copies `.env.example` to the repo-root `.env` (git-ignored, mode 0600) and generates
`PRVISION_SECRET_KEY`. It never overwrites a value you set.

| Key | Required | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | no | `development` | Runtime mode |
| `PORT` / `HOST` | no | `3100` / `127.0.0.1` | Backend listen address |
| `FRONTEND_URL` | no | `http://localhost:4210` | CORS and Origin check |
| `DATABASE_URL` | yes | `postgres://prvision:prvision@127.0.0.1:5433/prvision` | Postgres |
| `REDIS_URL` | yes | `redis://127.0.0.1:6380` | Redis / BullMQ |
| `PRVISION_SECRET_KEY` | yes | generated | Encrypts stored secrets |
| `PRVISION_DATA_DIR` | no | `~/.prvision` | Worktrees, artifacts, fixtures |
| `LOG_LEVEL` | no | `info` | Logger level |
| `PRVISION_PG_PORT` / `PRVISION_REDIS_PORT` | no | `5433` / `6380` | Docker host ports (Compose only) |

If 5433 or 6380 is busy and you have not pinned a port, `setup:env` picks the next free one and rewrites
`DATABASE_URL` / `REDIS_URL` to match. Non-secret tunables (timeouts, limits, names) live in
`backend/src/config-consts`, not in `.env`.

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

## Data and safety

- Data dir (`~/.prvision` by default): `worktrees/<id>/{base,head}`, `artifacts/<id>/<component>/{base,head,diff}.png`,
  `fixtures/`. Created with mode 0700.
- Your working copy is never modified. PRVision only creates its own worktrees and `refs/prvision/*` refs.
- The GitHub token and Anthropic API key are encrypted at rest with `PRVISION_SECRET_KEY` and never returned by the API.
- The backend binds `127.0.0.1` only; Postgres and Redis ports bind to `127.0.0.1` only.

## Troubleshooting

- **Port 5433 or 6380 in use:** `npm run setup:env` moves to a free port when the port is not pinned. If you pinned
  `PRVISION_PG_PORT` / `PRVISION_REDIS_PORT`, stop the other service or change both the port and the URL in `.env`.
- **Docker not running:** start Docker, then `npm run infra:up`.
- **`playwright install` behind a proxy:** set `HTTPS_PROXY` and rerun `npm run setup:browsers`.
- **npm "install scripts not covered by allowScripts":** expected for new dependencies; review with
  `npm install-scripts ls` and deny with `npm install-scripts deny <pkg>`. Builds work without them.
- **`missing_node_modules` when registering a repo:** run `npm install` in the target clone first.
- **Start over:** `npm run infra:reset` deletes all PRVision database and queue data. It cannot be undone.

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
