---
name: prvision
description: Render the UI changes in this repository with PRVision (before/after screenshots of every changed React or Angular component, side by side, with an AI summary) and show the user the report, without building or running their app and without any server. This session writes the render harnesses itself, through subagents. Use when the user says "use prvision", "run prvision", "prvision this", "show me the changes in prvision", "visualize my changes", or asks to see what a UI change looks like.
---

# PRVision

PRVision renders every React (Vite) or Angular component a change touches, before and after, and writes a report. It runs headless in one background process: no server, database or Docker. PRVision makes no AI call of its own; it hands each AI request (a render harness to write, a harness to fix, the run summary) to **this session**, and you answer them with subagents.

The command is `node ~/.claude/skills/prvision/prvision.mjs` (below: `PRVISION`). It never changes the user's code. It does write `.prvision/` in the repository: `config.json` (the setup answers) and `harnesses/` (saved harnesses, reused by every later run). Both are meant to be committed.

## 0. One-time install

If a command says "The engine is not built" or "The viewer is not built", run once, in the PRVision checkout it names: `npm install && npm run build` in `backend/` and in `frontend/`, then `npx playwright install chromium` in `backend/`. Tell the user you are doing it.

## 1. Start the run

From the repository being changed, run in the background (`run_in_background: true`):

```bash
PRVISION run
```

What it shows (`--source`, default `auto`): uncommitted changes when the working tree is dirty, otherwise the current branch against the default branch. `--source branch [--base <ref>]` shows the whole branch; `--source working` only uncommitted changes; `--head <branch> [--base <ref>]` another local branch.

**Exit code 4: first run in this repository.** Ask the setup questions in one AskUserQuestion call, then save the answers and start again:

- "Screen size" (header "Viewport"): Desktop (Recommended), Tablet, Mobile.
- "States per component": how many states (default, hover, open menu, error…) each harness may show. 3 (Recommended), 1, 5.
- "Components before asking": runs pause when more components need a new harness than this. 12 (Recommended), 5, 25.
- Only if the repository holds several apps (a monorepo: several folders with their own package.json and a Vite or Angular config): which app folder to render. Ask with the folders you found.

```bash
PRVISION init --viewport desktop --states 3 --limit 12 [--app-root apps/web] [--angular-project <name>]
```

**Model choice.** Right after the run starts (it prepares and analyzes for a while before the first request), ask which model writes the harnesses and the summary, unless the user already named one. AskUserQuestion, header "Model": "Same as this chat (Recommended)", "Opus", "Sonnet", "Haiku". Pass it as `model` on every subagent of the run; omit `model` for "Same as this chat".

## 2. Loop on the exit code

The output names the run folder; every later command takes it.

- **3: AI requests need answers.** The output lists one folder per request (`#<id> <purpose> <folder>`). For **each** folder, spawn a background subagent with the prompt in section 3. Then immediately run `PRVISION wait <runFolder>` in the background again: new requests (more harnesses, repairs, the summary) appear while subagents work. Keep going until the exit code is not 3. Do not read the task files yourself; they are large.
- **2: paused.** More components need new harnesses than the configured limit. Ask the user how many to render (max 100), then run `PRVISION continue <runFolder> --limit <n>` in the background.
- **1: failed or error.** Relay the message and the engine log path it prints. `missing_node_modules`: the repository needs its dependencies installed. `unsupported_framework`: PRVision supports React on Vite and Angular 17–21.
- **0: completed.** Go to section 4.

## 3. Subagent prompt

Spawn each with the model chosen in section 1. Replace `<folder>` and `<id>`:

```
You are answering one AI request for PRVision, a tool that renders UI components before and after a change.
Read <folder>/task.md and do exactly what it says; it gives the exact submit command.
Your answer is a JSON object matching <folder>/schema.json. Put long code in separate files and reference them
with "@file:<name>" string values.
If submitting prints validation errors, fix answer.json and submit again until it is accepted.
You may read the repository for context. Do not modify it.
Reply with one line: "accepted #<id>" or "failed #<id>: <reason>".
```

## 4. Show the report

Start the viewer in the background (`run_in_background: true`) and send the user the link it prints (`http://127.0.0.1:4317/report?...`):

```bash
PRVISION open <runFolder>
```

Then two or three lines: what changed visually and anything that looks wrong. Read the `diff.png` (and `head.png` where useful) of components with risk `likely_regression` or `check`; they are under `<runFolder>/report/artifacts/`. Mention render failures with their error line. Do not paste the whole summary; the user has it in the browser.

Finally, if `.prvision/` changed (first run, or new harnesses), tell the user to commit it with their change so the next run and their teammates reuse the harnesses.
