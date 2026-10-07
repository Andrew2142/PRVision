# Harness library, states and live mode: decisions

Source of truth for spec sheet 16. Every item below was decided in a planning discussion with the product owner on
2026-10-07. Where a choice was made by default (no explicit answer), it is marked **(default)**.

## Goal

Turn PRVision from "write a throwaway harness for each changed component, per run" into a **saved, per-repository
harness library** that:

1. covers the whole frontend app, so every component can be re-rendered on any run without AI cost;
2. captures several **states** per component, each compared before and after;
3. lets the reviewer **interact** with the before and after renders live, each side independently;
4. re-renders **every** saved component when a global style changes, so incidental CSS changes are caught (the
   gap competitors such as Chromatic cover by re-screenshotting every story).

Positioning: Chromatic-level coverage without hand-written stories; PRVision writes and maintains the harnesses.

Out of scope: Storybook and Chromatic integration of any kind (rendering through Storybook, importing stories,
Storybook file format). PRVision keeps its own harness engine. Two ideas are borrowed only as concepts: named states,
and scripted interactions per state.

## Decisions

### D1. Where the library lives

- Inside **PRVision only**: its database (and data dir if files are needed), one library per registered repository.
- The user's repository is never written to. No `.prvision/` folder in the repo.
- Consequence accepted: the library is per machine. Sharing is via export/import (D14).

### D2. Library entries and freshness

- One saved harness per component, keyed by repository + component file path + export name (React) or
  component class/selector identity (Angular), within the repository's app root.
- Each entry records a **fingerprint** of the component's source at the time the harness was written, so PRVision
  knows when the component has changed since.
- A saved harness is reused as long as it renders. It is not regenerated just because the fingerprint changed.

### D3. How the library is built: chosen when adding a repository

- The **Add repository** popup asks the user to choose:
  - **Grow as you go**: no upfront cost. Every run saves the harnesses it writes; the library fills in over time.
  - **Scan the whole app now**: builds harnesses for every component immediately.
- The popup shows an **estimate** before confirming (component count, approximate cost with the current model,
  reflecting the chosen state allowance).
- The repository page also has **Scan whole app** so a grow-as-you-go repository can switch to full coverage later.

### D4. State allowance (per repository)

- The Add repository popup also asks for a **state allowance**: the maximum number of states per component
  (range 1 to 5).
- It is a **maximum, not a target**. The AI writes only states that change how the component looks; simple components
  get just "Default". "Default" is always present.
- The allowance is **per repository**, editable later in that repository's settings.
- Changing the allowance later:
  - Repository built with **Scan the whole app**: a **Rescan** action rewrites every harness with the new allowance.
  - Repository on **Grow as you go**: new harnesses use the new allowance from then on.

### D5. What a state is

- A state is one named situation of a component ("Default", "Overdue", "Zero balance", "Long text", "Menu open"),
  expressed as different fake data and optionally a scripted interaction (for example "click the menu button")
  inside the same saved harness.
- The AI chooses states by reading the component's code: optional props, loading flags, empty collections, error
  branches, data-dependent rendering.
- Every state is rendered separately on both sides; before and after are matched **by state name**.
- The component card gets **state tabs**; each tab has the existing side by side, slider and diff views. Tabs whose
  pixels changed are marked.

### D6. Pull request runs: reuse on both sides

- For every component the run needs, PRVision uses the **saved harness on both sides** (base and head), keeping the
  same-harness principle.
- This also applies to components the PR itself changed: the saved harness is tried first. If the head side (or any
  side) fails to render, the card shows **"Harness needs updating"** (D8).
- New components without a saved harness get one written during the run (subject to D9) and saved to the library.

### D7. Global style changes: re-render everything

- When a run's changes include a global stylesheet (repository `globalStylePaths`), the Tailwind config, PostCSS
  config, design tokens, or `index.html`, the run re-renders **every component in the library**, all states, both
  sides.
- Rendering from the library uses no AI.
- Results show only components whose pixels changed: "201 checked, 14 changed".
- This replaces today's behaviour (a few "representative" components for global stylesheets; only a console warning
  for Tailwind config and `index.html`).

### D8. Repair is manual only

- When a saved harness stops rendering, the run continues; that card shows **"Harness needs updating"** with a
  **Repair** button. A run-level **Repair all broken** button repairs every broken card in that run.
- Nothing repairs saved harnesses automatically. No loops, no unprompted AI spend.
- A repair saves the new harness to the library; later runs use it.
- **(default)** Writing a **brand-new** harness keeps today's single built-in fix-up (one retry with the build or
  render error, then stop). This is bounded and does not apply to saved harnesses.

### D9. The component pause

- The run pauses for confirmation only when it would write **more than 12 new harnesses** (today's `MAX_COMPONENTS`
  limit now counts new harnesses, not components).
- Re-rendering from the library never pauses, so a global style change re-checks the whole library without asking.

### D10. Live mode

- On each component card, alongside Side by side, Slider and Diff, a **Live** mode shows the before and after as
  running components side by side. Each side is independent: clicking on one side affects only that side.
- Live mode starts **on click** (a Live button). Screenshots remain the default view.
- One Live click starts a before-side and an after-side build server for the run; all cards in that run can then go
  live. Live starts from the state tab currently open.
- Before/after code is recreated on demand from the run's commit SHAs and the saved harnesses, so older runs can go
  live too.
- Live servers stop when the user **leaves the run, or after 10 minutes idle**, whichever comes first.
- Pixel diff, slider and the AI summary still use screenshots.

### D11. What the full scan covers

- **Every component** in the app root, **smallest first**: building blocks (no or few component children) before
  screens. Components that will not render on their own are marked "needs updating"; the scan continues.

### D12. How the scan runs

- A **background job** with a progress page like a run: "84 of 201 harnesses written, about $12 spent".
- **Cancel** keeps everything written so far. **Continue scan** on the repository page resumes with what is missing.
- A **spending cap** is set in the scan popup (for example "stop at $20"). The scan pauses when the cap is reached;
  the user continues manually if they want more.

### D13. Cost

- AI cost is paid when harnesses are written (scan, grow-as-you-go, new components, repairs). Re-rendering is free.
- The scan estimate and progress show money in the user's currency-neutral dollars from token usage and the model's
  published prices.

### D14. Export and import

- An **Export library** action on the repository page produces one file containing the **harnesses and the
  repository's state allowance**. No screenshots.
- **Import library** on a teammate's PRVision loads it into the matching repository; that machine renders its own
  screenshots (free), so comparisons are not affected by another machine's font rendering.

### D15. Build order **(default: recommended option)**

1. **Library and states together** (D1-D9, D11-D13): states change the shape of a saved harness, so the harness format
   is multi-state from the first version and no library has to be written twice.
2. **Live mode** (D10).
3. **Export and import** (D14).

## Non-goals

- Storybook, Chromatic, Playwright-test or Cypress integration.
- Writing anything into the user's repository.
- Automatic repair of saved harnesses.
- Whole-app flows (navigating between pages with routing, auth and data); live mode works per component.
- Sharing the library through a server or CI; sharing is by export/import only.
- A per-run spending limit (the cap applies to the scan job only).
