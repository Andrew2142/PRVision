# PRVision

See what a pull request does to your UI.

Every component a change touches, rendered before and after, side by side.
A pixel diff, and a short note on what to check.

## Start

```bash
docker compose up
```

Open <http://localhost:4210>. Add a GitHub token and an Anthropic API key in Settings, then add a repository from your home folder.

Needs Docker. To run without it: `npm run setup && npm run dev` (Node 22.12+, git).

## How

AI writes a small harness for each component.
Your own build renders it in headless Chromium, once for base, once for head.
Same harness on both sides, so every changed pixel came from your code.

React on Vite. Angular 17 to 21.

## Local

Runs on `127.0.0.1`. Works in its own git worktrees. Never touches your working copy.

## Claude Code

PRVision can also write harnesses through a locally installed Claude Code.
Anthropic does not allow third-party tools to use Claude.ai subscription logins,
so use it only with Claude Code signed in with an API key.

---

[Setup reference](docs/SETUP.md) · [Specs](docs/specs/)
