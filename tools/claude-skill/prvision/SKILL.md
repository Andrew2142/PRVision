---
name: prvision
description: Render the UI changes just made in this repository with PRVision (before/after screenshots, pixel diff, AI summary) so the user can see them without building or running the app. Use when the user says "run prvision", "prvision this", "show me the changes in prvision", "visualize my changes", or asks to see what the UI change looks like.
---

# PRVision

PRVision renders every React or Angular component a change touches, before and after, with a pixel diff and an AI summary. This skill drives a local PRVision through its API. It never changes the user's working copy.

## Run it

Run the driver from the repository you changed, **in the background** (`run_in_background: true`); a run takes a few minutes and you are notified when it exits:

```bash
node ~/.claude/skills/prvision/prvision-run.mjs
```

It starts PRVision with Docker if it is down, switches PRVision's AI provider to Claude Code (the user's subscription, not the API key) if it is not already, registers the repository if needed, starts the run, opens it in the browser, and waits.

What it visualizes (`--source`, default `auto`):

- `auto`: uncommitted changes if the working tree is dirty; otherwise the current branch against the repository's default branch.
- `working`: uncommitted changes only.
- `branch`: the whole current branch against `--base <ref>` (default: the repository's default branch). Use this when the work was committed, or when the user asks for everything on the branch.

Other flags: `--path <dir>` (another repository), `--limit <n>` (render up to n components without pausing), `--no-open` (no browser).

## Exit codes

- **0**: completed. The output has the run URL, the summary, and every component sorted by risk with its `base`, `head` and `diff` PNG paths.
- **2**: paused. More than 12 components changed and PRVision waits before spending AI tokens. Tell the user the count and ask how many to render. Then run `node ~/.claude/skills/prvision/prvision-run.mjs continue <id> --limit <n>` in the background. If the user picks in the browser instead, run `... wait <id>`.
- **1**: failed or error. Relay the message. Common fixes: `ai_not_configured` or `ai_unauthorized` → the user runs `claude auth login` in a terminal; `missing_node_modules` → install dependencies in the repository; `unsupported_framework` → PRVision supports React on Vite and Angular 17–21.

## Report

When it completes:

1. Give the run URL.
2. Read the `diff` PNGs (and `head` where useful) of components with risk `likely_regression` or `check`, and of anything that failed to render. Say in a sentence each what changed visually and whether it looks intended given the work you just did.
3. Flag render failures with their error line. Do not paste the whole summary; the user has it in the browser.
