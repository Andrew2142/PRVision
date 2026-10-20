---
name: prvision
description: Render the UI changes just made in this repository with PRVision (before/after screenshots, pixel diff, summary) and send the user a link, without building or running the app. This session writes the render harnesses itself, through subagents. Use when the user says "use prvision", "run prvision", "prvision this", "show me the changes in prvision", "visualize my changes", or asks to see what a UI change looks like.
---

# PRVision

PRVision renders every React or Angular component a change touches, before and after, with a pixel diff. In agent mode (the default) PRVision makes no AI call of its own: it hands each AI request (a render harness to write, a harness to fix, the run summary) to **this session**, and you answer them with subagents. The driver script is `~/.claude/skills/prvision/prvision-run.mjs`. It never changes the user's working copy.

## 1. Start the run

From the repository you changed, run in the background (`run_in_background: true`):

```bash
node ~/.claude/skills/prvision/prvision-run.mjs
```

It starts PRVision with Docker if it is down, registers the repository if needed, starts the run, opens it in the browser and prints `Link: http://localhost:4210/visualizations/<id>`. Send the user that link as soon as you see it.

**Model choice.** Right after starting the run (it prepares and analyzes for a while before the first request), ask which model writes the harnesses and the summary, unless the user already named one ("use prvision with sonnet"). Use AskUserQuestion with header "Model" and these options:

- "Same as this chat (Recommended)": subagents inherit this session's model.
- "Opus": best harnesses on complex components.
- "Sonnet": good balance of quality and speed.
- "Haiku": fastest and cheapest; fine for simple components.

Remember the answer for the whole run and pass it as `model` (`opus`, `sonnet`, `haiku`, or `fable` if the user typed it) on every subagent you spawn in section 3. For "Same as this chat", omit `model`. Answer requests that arrive before the user replies with the chat's model rather than waiting.

What it visualizes (`--source`, default `auto`): uncommitted changes when the working tree is dirty, otherwise the current branch against the default branch. `--source branch [--base <ref>]` shows the whole branch; `--source working` only uncommitted changes. Other flags: `--path <dir>`, `--limit <n>` (render up to n components without pausing), `--no-open`, `--ai settings` (use PRVision's own configured AI provider instead of this session).

## 2. Loop on the exit code

- **3: AI requests need answers.** The output lists one folder per request (`#<id> <purpose> <folder>`). For **each** folder, spawn a background subagent with the prompt in section 3. Then immediately run `node ~/.claude/skills/prvision/prvision-run.mjs wait <runId>` in the background again: new requests (more harnesses, repairs, the summary) appear while subagents work. Keep going until the exit code is not 3. Do not read the task files yourself; they are large.
- **2: paused.** More than 12 components need new harnesses. Ask the user how many to render (max 100), then run `... continue <runId> --limit <n>` in the background.
- **1: failed or error.** Relay the message. `missing_node_modules`: the repository needs its dependencies installed. `unsupported_framework`: PRVision supports React on Vite and Angular 17–21. "No Claude Code session picked up the request": the loop above stopped; start a new run.
- **0: completed.** Go to section 4.

## 3. Subagent prompt

Spawn each with the model chosen in section 1 (the Agent tool's `model` parameter). Replace `<folder>`, `<id>` and `<repository>` (the repository path printed in the task file header; the current repository is fine):

```
You are answering one AI request for PRVision, a tool that renders UI components before and after a change.
Read <folder>/task.md and do exactly what it says. Your answer is a JSON object matching <folder>/schema.json.
Put long code in separate files and reference them with "@file:<name>" string values.
Submit with: node ~/.claude/skills/prvision/prvision-run.mjs answer <id> <folder>/answer.json
If it prints validation errors, fix answer.json and submit again until it is accepted.
You may read files in <repository> for context. Do not modify them.
Reply with one line: "accepted #<id>" or "failed #<id>: <reason>".
```

## 4. Report

Send the link again with two or three lines: what changed visually and anything that looks wrong. Read the `diff` PNGs (and `head` where useful) of components with risk `likely_regression` or `check`, and mention render failures with their error line. Do not paste the whole summary; the user has it in the browser.
