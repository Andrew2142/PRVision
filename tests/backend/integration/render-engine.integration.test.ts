/**
 * Render engine integration test (sheet 10 §9.9): real Vite (the fixture's own Vite 7) and real Chromium against
 * copies of the fixture repo, with scripted harnesses and a scripted repairer (no AI). Gated on
 * PRVISION_IT_RENDER=1 or PRVISION_INTEGRATION=1; fails (does not skip) when the gate is on and the fixture is missing.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { PIXELMATCH_THRESHOLD } from "../../../backend/src/config-consts";
import {
  ArtifactStoreRenderAdapter,
  RenderService,
  type RenderComponentInput,
  type RepairHarnessFn
} from "../../../backend/src/services/visualizations/pipeline/render-service";
import { BrowserSession } from "../../../backend/src/services/visualizations/pipeline/render/browser-session";
import {
  harnessRootRelative,
  resolveSideLayout
} from "../../../backend/src/services/visualizations/pipeline/render/harness-workspace";
import { ViteHostClient } from "../../../backend/src/services/visualizations/pipeline/render/vite-host-client";
import type { ViteHostHandle } from "../../../backend/src/services/visualizations/pipeline/render/render-types";
import type {
  ComponentRenderResult,
  HarnessGenerationResult,
  HarnessRenderError,
  HarnessRepairOutcome
} from "../../../backend/src/types/visualization-pipeline";
import { ArtifactStore } from "../../../backend/src/utilities/services/artifact-store";
import { createPipelineContext } from "../helpers/pipeline-context";
import { makeTempDir } from "../helpers/temp-dir";
import { InMemoryPersistence, candidate } from "../render/helpers/render-stubs";
import { requireFixtureRepo } from "./helpers/fixture";
import { itSkip } from "./helpers/it-flags";

const SKIP = itSkip("render");

/** Temp dirs created inside before() hooks; removed by the file-level after() (an after() registered inside a
 *  before() hook would run right after that hook). */
const cleanups: Array<() => void> = [];
after(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});
const IT_DIR = "src/__prvision_it__";

const COMPONENTS: Record<string, string> = {
  "Swatch.tsx": `export default function Swatch() {\n  return <div className="h-24 w-24 bg-red-500" />;\n}\n`,
  "api.ts": `throw new Error("network not allowed");\nexport const getName = (): string => "Real";\n`,
  "Greeting.tsx": `import { getName } from "./api";\nexport default function Greeting() {\n  return <p className="text-lg">Hello {getName()}</p>;\n}\n`,
  "Modal.tsx": `import { createPortal } from "react-dom";\nexport default function Modal() {\n  return createPortal(\n    <div className="fixed inset-0 bg-black/50"><div className="bg-white p-6">Hello</div></div>,\n    document.body\n  );\n}\n`,
  "Thrower.tsx": `export default function Thrower(): never {\n  throw new Error("boom from Thrower");\n}\n`,
  "RemoteImage.tsx": `import { useEffect, useState } from "react";\nexport default function RemoteImage() {\n  const [data, setData] = useState<unknown>(null);\n  useEffect(() => {\n    fetch("https://example.com/api").then((r) => r.json()).then(setData, () => setData("failed"));\n  }, []);\n  return (\n    <div>\n      <img src="https://example.com/a.png" width={40} height={40} />\n      <span>{JSON.stringify(data)}</span>\n    </div>\n  );\n}\n`
};
// "SwatchChange" is red on base and blue on head (the "different" case); every other file is identical.
const SWATCH_CHANGE_BASE = `export default function SwatchChange() {\n  return <div className="h-24 w-24 bg-red-500" />;\n}\n`;
const SWATCH_CHANGE_HEAD = `export default function SwatchChange() {\n  return <div className="h-24 w-24 bg-blue-500" />;\n}\n`;

function harness(
  componentId: number,
  importPath: string,
  body: string,
  notes = "Scripted harness."
): HarnessGenerationResult {
  return {
    componentId,
    harnessSource: `import { definePrvisionHarness } from "../harness-api";\nimport Target from "${importPath}";\n${body.includes("Target") ? "" : "void Target;\n"}export default definePrvisionHarness({\n  states: [{ name: "Default", render: () => ${body} }]\n});\n`,
    mockedModules: [],
    notes,
    states: [{ name: "Default", steps: [] }],
    origin: "written",
    libraryEntryId: null
  };
}

function itImport(name: string): string {
  return `../../${IT_DIR}/${name}`;
}

function copyFixture(source: string, target: string): void {
  fs.cpSync(source, target, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(source, src);
      const top = rel.split(path.sep)[0];
      return top !== "node_modules" && top !== ".git" && top !== "dist";
    }
  });
  fs.symlinkSync(path.join(source, "node_modules"), path.join(target, "node_modules"), "dir");
}

/** `git archive <ref>` of the fixture into `target` (read-only on the fixture) plus the node_modules symlink. */
function exportBranch(fixture: string, ref: string, target: string): void {
  fs.mkdirSync(target, { recursive: true });
  const tar = execFileSync("git", ["-C", fixture, "archive", "--format=tar", ref], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", target], { input: tar });
  fs.symlinkSync(path.join(fixture, "node_modules"), path.join(target, "node_modules"), "dir");
}

function writeItComponents(root: string, side: "base" | "head"): void {
  const dir = path.join(root, IT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(COMPONENTS)) {
    fs.writeFileSync(path.join(dir, file), content);
  }
  fs.writeFileSync(path.join(dir, "SwatchChange.tsx"), side === "base" ? SWATCH_CHANGE_BASE : SWATCH_CHANGE_HEAD);
}

function readPng(file: string): PNG {
  return PNG.sync.read(fs.readFileSync(file));
}

function diffRatio(a: PNG, b: PNG): number {
  assert.equal(a.width, b.width, "same canvas width");
  assert.equal(a.height, b.height, "same canvas height");
  const changed = pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: PIXELMATCH_THRESHOLD });
  return changed / (a.width * a.height);
}

function pixel(png: PNG, x: number, y: number): [number, number, number, number] {
  const index = (png.width * y + x) * 4;
  return [png.data[index] ?? 0, png.data[index + 1] ?? 0, png.data[index + 2] ?? 0, png.data[index + 3] ?? 0];
}

function portRefusesConnections(origin: string): Promise<boolean> {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port: Number(port) });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      resolve(true);
    });
  });
}

interface RunOutput {
  results: ComponentRenderResult[];
  persistence: InMemoryPersistence;
  repairCalls: Array<{ componentId: number; renderError: HarnessRenderError }>;
  origins: string[];
  dataDir: string;
}

async function runRender(options: {
  baseDir: string;
  headDir: string;
  fixture: string;
  visualizationId: number;
  inputs: RenderComponentInput[];
  repairs?: Record<number, HarnessGenerationResult>;
}): Promise<RunOutput> {
  const dataDirTemp = makeTempDir("it-render-data");
  cleanups.push(dataDirTemp.cleanup);
  const dataDir = dataDirTemp.path;
  const persistence = new InMemoryPersistence();
  const repairCalls: RunOutput["repairCalls"] = [];
  const origins: string[] = [];
  const repairHarness: RepairHarnessFn = (componentId, _previous, renderError): Promise<HarnessRepairOutcome> => {
    repairCalls.push({ componentId, renderError });
    const repaired = options.repairs?.[componentId];
    return Promise.resolve(
      repaired === undefined
        ? { ok: false, reason: "budget_exhausted", message: "repair budget exhausted" }
        : { ok: true, result: repaired }
    );
  };
  const handle = createPipelineContext({
    visualizationId: options.visualizationId,
    dataDir,
    repositoryPath: options.fixture,
    baseDir: options.baseDir,
    headDir: options.headDir,
    repository: { viteConfigPath: "vite.config.ts", globalStylePaths: ["/src/index.css"] }
  });
  const service = new RenderService({
    repairHarness,
    createPersistence: () => persistence,
    artifactStore: new ArtifactStoreRenderAdapter(new ArtifactStore(dataDir)),
    startViteHost: async (startOptions, harnessUrlPath, signal): Promise<ViteHostHandle> => {
      const host = await ViteHostClient.start(startOptions, harnessUrlPath, signal);
      origins.push(host.origin);
      return host;
    }
  });
  const results = await service.renderAll(handle.context, options.inputs);
  handle.console.assertStagesAreStatusNames();
  return { results, persistence, repairCalls, origins, dataDir };
}

function sideImage(run: RunOutput, componentId: number, side: "base" | "head"): PNG {
  const result = run.results.find((entry) => entry.componentId === componentId);
  const sideResult = result?.[side];
  assert.ok(sideResult?.ok, `component ${String(componentId)} ${side} rendered: ${sideResult?.error ?? "missing"}`);
  assert.ok(sideResult.imagePath);
  return readPng(path.join(run.dataDir, sideResult.imagePath));
}

describe("render engine against the fixture repo (real Vite + Chromium)", { timeout: 300_000 }, () => {
  let fixture = "";
  let root = "";
  let viteCacheBefore = false;
  let viteTempBefore = false;
  let first: RunOutput | null = null;
  let second: RunOutput | null = null;

  const ids = { swatch: 101, change: 102, greeting: 103, modal: 104, thrower: 105, missing: 106, remote: 107 };

  before(async () => {
    if (SKIP !== false) {
      return;
    }
    fixture = requireFixtureRepo();
    viteCacheBefore = fs.existsSync(path.join(fixture, "node_modules", ".vite"));
    viteTempBefore = fs.existsSync(path.join(fixture, "node_modules", ".vite-temp"));
    const temp = makeTempDir("it-render");
    cleanups.push(temp.cleanup);
    root = temp.path;
    for (const side of ["base", "head"] as const) {
      copyFixture(fixture, path.join(root, side));
      writeItComponents(path.join(root, side), side);
    }
    const inputs: RenderComponentInput[] = [
      {
        candidate: candidate(ids.swatch, `${IT_DIR}/Swatch.tsx`, "modified", 0),
        harness: harness(ids.swatch, itImport("Swatch"), "<Target />"),
        basePath: `${IT_DIR}/Swatch.tsx`
      },
      {
        candidate: candidate(ids.change, `${IT_DIR}/SwatchChange.tsx`, "modified", 1),
        harness: harness(ids.change, itImport("SwatchChange"), "<Target />"),
        basePath: `${IT_DIR}/SwatchChange.tsx`
      },
      {
        candidate: candidate(ids.greeting, `${IT_DIR}/Greeting.tsx`, "modified", 2),
        harness: {
          ...harness(ids.greeting, itImport("Greeting"), "<Target />"),
          mockedModules: [{ specifier: "./api", source: "export const getName = () => 'Mocked';" }]
        },
        basePath: `${IT_DIR}/Greeting.tsx`
      },
      {
        candidate: candidate(ids.modal, `${IT_DIR}/Modal.tsx`, "modified", 3),
        harness: harness(ids.modal, itImport("Modal"), "<Target />"),
        basePath: `${IT_DIR}/Modal.tsx`
      },
      {
        candidate: candidate(ids.thrower, `${IT_DIR}/Thrower.tsx`, "modified", 4),
        harness: harness(ids.thrower, itImport("Thrower"), "<Target />"),
        basePath: `${IT_DIR}/Thrower.tsx`
      },
      {
        candidate: candidate(ids.missing, `${IT_DIR}/Swatch.tsx`, "modified", 5),
        harness: {
          componentId: ids.missing,
          harnessSource: `import { definePrvisionHarness } from "../harness-api";\nimport Target from "${itImport("Swatch")}";\nimport { helper } from "./does-not-exist";\nexport default definePrvisionHarness({\n  states: [{ name: "Default", render: () => <div data-x={String(helper)}><Target /></div> }]\n});\n`,
          mockedModules: [],
          notes: "Scripted harness with a broken import.",
          states: [{ name: "Default", steps: [] }],
          origin: "written",
          libraryEntryId: null
        },
        basePath: `${IT_DIR}/Swatch.tsx`
      }
    ];
    first = await runRender({
      baseDir: path.join(root, "base"),
      headDir: path.join(root, "head"),
      fixture,
      visualizationId: 9001,
      inputs,
      repairs: { [ids.missing]: harness(ids.missing, itImport("Swatch"), "<Target />", "Repaired.") }
    });
    second = await runRender({
      baseDir: path.join(root, "base"),
      headDir: path.join(root, "head"),
      fixture,
      visualizationId: 9002,
      inputs: inputs.slice(0, 1)
    });
  });

  test("renders the same component on identical base and head with zero pixel difference", { skip: SKIP }, () => {
    assert.ok(first);
    const base = sideImage(first, ids.swatch, "base");
    const head = sideImage(first, ids.swatch, "head");
    assert.equal(base.width, head.width);
    assert.equal(base.height, head.height);
    assert.equal(Buffer.compare(base.data, head.data), 0);
    assert.equal(first.persistence.latest(ids.swatch)?.renderStatus, "rendered");
  });

  test("rendering the same component twice gives identical pixels", { skip: SKIP }, () => {
    assert.ok(first && second);
    const one = sideImage(first, ids.swatch, "head");
    const two = sideImage(second, ids.swatch, "head");
    assert.equal(diffRatio(one, two), 0);
    assert.equal(Buffer.compare(one.data, two.data), 0);
  });

  test("detects a real visual change between base and head", { skip: SKIP }, () => {
    assert.ok(first);
    const base = sideImage(first, ids.change, "base");
    const head = sideImage(first, ids.change, "head");
    const ratio = diffRatio(base, head);
    assert.ok(ratio > 0.4, `ratio ${String(ratio)}`);
    const [br, , bb] = pixel(base, 40, 40);
    const [hr, , hb] = pixel(head, 40, 40);
    assert.ok(br > bb + 100, `base pixel is red: ${String(br)},${String(bb)}`);
    assert.ok(hb > hr + 100, `head pixel is blue: ${String(hr)},${String(hb)}`);
  });

  test("applies Tailwind classes", { skip: SKIP }, () => {
    assert.ok(first);
    const [r, g, b] = pixel(sideImage(first, ids.swatch, "head"), 40, 40);
    assert.ok(r >= 200 && g <= 90 && b <= 90, `swatch pixel is red: ${String(r)},${String(g)},${String(b)}`);
  });

  test("applies a mock so a module that throws on import is never loaded", { skip: SKIP }, () => {
    assert.ok(first);
    const result = first.results.find((entry) => entry.componentId === ids.greeting);
    assert.equal(result?.head?.ok, true, result?.head?.error ?? "");
    assert.equal(result.base?.ok, true, result.base?.error ?? "");
  });

  test("reports an unresolved import with the missing specifier and calls repair once", { skip: SKIP }, () => {
    assert.ok(first);
    const calls = first.repairCalls.filter((call) => call.componentId === ids.missing);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.renderError.kind, "module_load");
    assert.match(calls[0].renderError.message, /does-not-exist/);
    assert.deepEqual(calls[0].renderError.sides, ["base", "head"]);
    const payload = first.persistence.latest(ids.missing);
    assert.equal(payload?.renderStatus, "rendered");
    assert.equal(payload.harness?.harnessNotes, "Repaired.");
  });

  test("reports a render error with message and component stack", { skip: SKIP }, () => {
    assert.ok(first);
    const calls = first.repairCalls.filter((call) => call.componentId === ids.thrower);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.renderError.kind, "render_error");
    const payload = first.persistence.latest(ids.thrower);
    assert.equal(payload?.renderStatus, "failed");
    for (const error of [payload.baseError, payload.headError]) {
      assert.match(error ?? "", /boom from Thrower/);
      assert.match(error ?? "", /Thrower/);
      assert.match(error ?? "", /Component stack:/);
      assert.doesNotMatch(error ?? "", /127\.0\.0\.1/);
      assert.ok(!(error ?? "").includes(root), "no absolute worktree paths");
    }
  });

  test("captures portals in viewport mode", { skip: SKIP }, () => {
    assert.ok(first);
    const head = sideImage(first, ids.modal, "head");
    assert.equal(head.width, 1280);
    assert.ok(head.height >= 800);
  });

  test("serves off-origin images and fetches locally", { skip: SKIP }, async () => {
    assert.ok(first);
    const layout = resolveSideLayout("head", path.join(root, "head"), "vite.config.ts");
    fs.writeFileSync(
      path.join(layout.componentsDir, `${String(ids.remote)}.tsx`),
      `/** @jsxRuntime automatic */\nimport { definePrvisionHarness } from "../harness-api";\nimport Target from "${itImport("RemoteImage")}";\nexport default definePrvisionHarness({ states: [{ name: "Default", render: () => <Target /> }] });\n`
    );
    const controller = new AbortController();
    const host = await ViteHostClient.start(
      {
        side: "head",
        groupKey: "none",
        worktreeDir: layout.worktreeDir,
        viteRoot: layout.viteRoot,
        harnessDir: layout.harnessDir,
        cacheDir: layout.cacheDir,
        configFile: layout.configFile,
        optimizeEntries: [harnessRootRelative(layout, "entry.tsx"), harnessRootRelative(layout, "globals.ts")],
        warmupFiles: [harnessRootRelative(layout, "entry.tsx")],
        referencedEnvKeys: [],
        mocks: []
      },
      layout.harnessUrlPath,
      controller.signal
    );
    const session = await BrowserSession.launch();
    const output = path.join(root, "remote.png");
    try {
      const startedAt = Date.now();
      const outcome = await session.renderComponent({
        host,
        componentId: ids.remote,
        stateName: "Default",
        timeoutMs: 60_000,
        outputPath: output,
        signal: controller.signal,
        checkStylesheets: null
      });
      assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.error);
      assert.ok(outcome.blockedRequests >= 2, `blocked ${String(outcome.blockedRequests)}`);
      assert.ok(Date.now() - startedAt < 30_000);
    } finally {
      await session.close();
      await host.stop();
      // This test drives a host without RenderService, so it removes Vite's config bundling folder itself.
      if (!viteTempBefore) {
        try {
          fs.rmdirSync(path.join(fixture, "node_modules", ".vite-temp"));
        } catch {
          // Not created or not empty.
        }
      }
    }
  });

  test("cleans up hosts and browser", { skip: SKIP }, async () => {
    assert.ok(first && second);
    assert.equal(ViteHostClient.liveCount(), 0);
    assert.ok(first.origins.length >= 2);
    for (const origin of [...first.origins, ...second.origins]) {
      assert.equal(await portRefusesConnections(origin), true, `${origin} still accepts connections`);
    }
    assert.equal(
      fs.existsSync(path.join(fixture, "node_modules", ".vite")),
      viteCacheBefore,
      "node_modules/.vite untouched"
    );
    assert.equal(
      fs.existsSync(path.join(fixture, "node_modules", ".vite-temp")),
      viteTempBefore,
      "Vite's config bundling folder is removed again"
    );
  });
});

describe("render engine: fixture Button on feature/button-restyle", { timeout: 300_000 }, () => {
  let runs: RunOutput[] = [];
  let buttonViteTempBefore = false;
  const buttonId = 201;

  before(async () => {
    if (SKIP !== false) {
      return;
    }
    const fixture = requireFixtureRepo();
    buttonViteTempBefore = fs.existsSync(path.join(fixture, "node_modules", ".vite-temp"));
    const temp = makeTempDir("it-button");
    cleanups.push(temp.cleanup);
    exportBranch(fixture, "main", path.join(temp.path, "base"));
    exportBranch(fixture, "feature/button-restyle", path.join(temp.path, "head"));
    const input: RenderComponentInput = {
      candidate: candidate(buttonId, "src/components/Button.tsx", "modified", 0),
      harness: harness(
        buttonId,
        "../../src/components/Button",
        `<div style={{ display: "flex", gap: 12 }}><Target>Save changes</Target><Target variant="secondary">Cancel</Target></div>`
      ),
      basePath: "src/components/Button.tsx"
    };
    runs = [];
    for (const visualizationId of [9101, 9102]) {
      runs.push(
        await runRender({
          baseDir: path.join(temp.path, "base"),
          headDir: path.join(temp.path, "head"),
          fixture,
          visualizationId,
          inputs: [input]
        })
      );
    }
  });

  test("renders Button on both sides with a non-trivial difference", { skip: SKIP }, () => {
    const run = runs[0];
    assert.ok(run);
    assert.equal(run.persistence.latest(buttonId)?.renderStatus, "rendered");
    const base = sideImage(run, buttonId, "base");
    const head = sideImage(run, buttonId, "head");
    // The restyle makes the buttons larger, so compare on the shared canvas (top-left anchored, like sheet 11).
    const width = Math.max(base.width, head.width);
    const height = Math.max(base.height, head.height);
    const pad = (png: PNG): PNG => {
      const out = new PNG({ width, height });
      out.data.fill(255);
      PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0);
      return out;
    };
    const ratio = diffRatio(pad(base), pad(head));
    assert.ok(head.width > base.width || head.height > base.height, "head buttons are roomier");
    assert.ok(ratio > 0.02, `ratio ${String(ratio)}`);
  });

  test("rendering Button twice gives ratio 0", { skip: SKIP }, () => {
    const [one, two] = runs;
    assert.ok(one && two);
    for (const side of ["base", "head"] as const) {
      assert.equal(diffRatio(sideImage(one, buttonId, side), sideImage(two, buttonId, side)), 0);
    }
    assert.equal(ViteHostClient.liveCount(), 0);
    assert.equal(fs.existsSync(path.join(requireFixtureRepo(), "node_modules", ".vite-temp")), buttonViteTempBefore);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 16 §20.2 / §20.5: multi-state harness, scripted steps with real input, per-state images
// ---------------------------------------------------------------------------------------------------------------

const MENU_COMPONENT = `import { useState } from "react";
export default function Menu() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ padding: 16 }}>
      <style>{".prv-it-more:hover { background: rgb(0, 0, 255) !important; }"}</style>
      <button className="prv-it-more" style={{ background: "rgb(255, 255, 255)", padding: 8 }} onClick={() => setOpen(true)}>
        More actions
      </button>
      {open ? <ul style={{ margin: 0 }}><li>Rename</li><li>Delete</li></ul> : null}
    </div>
  );
}
`;

describe("render engine: multi-state harness with steps (16b/16e)", { timeout: 300_000 }, () => {
  let run: RunOutput | null = null;
  const menuId = 301;

  before(async () => {
    if (SKIP !== false) {
      return;
    }
    const fixture = requireFixtureRepo();
    const temp = makeTempDir("it-states");
    cleanups.push(temp.cleanup);
    for (const side of ["base", "head"] as const) {
      copyFixture(fixture, path.join(temp.path, side));
      fs.mkdirSync(path.join(temp.path, side, IT_DIR), { recursive: true });
      fs.writeFileSync(path.join(temp.path, side, IT_DIR, "Menu.tsx"), MENU_COMPONENT);
    }
    const target = { by: "role" as const, role: "button", name: "More actions" };
    const states = [
      { name: "Default", steps: [] },
      { name: "Menu open", steps: [{ action: "click", target }] },
      { name: "Hovered", steps: [{ action: "hover", target }] },
      { name: "Missing", steps: [{ action: "click", target: { by: "text" as const, text: "No such element" } }] }
    ] as const;
    const source = [
      'import { definePrvisionHarness } from "../harness-api";',
      `import Target from "${itImport("Menu")}";`,
      "export default definePrvisionHarness({",
      "  states: [",
      ...states.map(
        (state) =>
          `    { name: ${JSON.stringify(state.name)}, render: () => <Target />, steps: ${JSON.stringify(state.steps)} },`
      ),
      "  ]",
      "});",
      ""
    ].join("\n");
    run = await runRender({
      baseDir: path.join(temp.path, "base"),
      headDir: path.join(temp.path, "head"),
      fixture,
      visualizationId: 9301,
      inputs: [
        {
          candidate: candidate(menuId, `${IT_DIR}/Menu.tsx`, "modified", 0),
          harness: {
            componentId: menuId,
            harnessSource: source,
            mockedModules: [],
            notes: "Scripted multi-state harness.",
            states: states.map((state) => ({ name: state.name, steps: [...state.steps] })),
            origin: "library", // never repaired: the missing step stays a step_failed state
            libraryEntryId: null
          },
          basePath: `${IT_DIR}/Menu.tsx`
        }
      ]
    });
  });

  test("renders one PNG pair per state at the state paths", { skip: SKIP }, () => {
    assert.ok(run);
    const result = run.results[0];
    assert.ok(result);
    assert.deepEqual(
      result.states.map((state) => [state.stateName, state.base?.ok, state.head?.ok]),
      [
        ["Default", true, true],
        ["Menu open", true, true],
        ["Hovered", true, true],
        ["Missing", false, false]
      ]
    );
    for (const [ordinal, folder] of [
      [0, ""],
      [1, "s1/"],
      [2, "s2/"]
    ] as const) {
      for (const side of ["base", "head"] as const) {
        const file = path.join(run.dataDir, `artifacts/9301/${String(menuId)}/${folder}${side}.png`);
        assert.ok(fs.existsSync(file), `${String(ordinal)} ${side}`);
      }
    }
  });

  test("a click step and a hover step change only their own state's pixels", { skip: SKIP }, () => {
    assert.ok(run);
    const image = (folder: string): PNG =>
      readPng(path.join(run?.dataDir ?? "", `artifacts/9301/${String(menuId)}/${folder}head.png`));
    const base = image("");
    const open = image("s1/");
    const hovered = image("s2/");
    assert.ok(open.height > base.height || diffRatio(base, open) > 0, "the open menu adds content");
    assert.ok(diffRatio(base, hovered) > 0, "the hover style is captured");
    // Base and head of every rendered state are identical (same code on both sides).
    for (const folder of ["", "s1/", "s2/"]) {
      const baseSide = readPng(path.join(run.dataDir, `artifacts/9301/${String(menuId)}/${folder}base.png`));
      assert.equal(diffRatio(baseSide, image(folder)), 0, folder);
    }
  });

  test("a missing step target fails only its state with step_failed", { skip: SKIP }, () => {
    assert.ok(run);
    const payload = run.persistence.latest(menuId);
    assert.ok(payload);
    assert.equal(payload.renderStatus, "partial");
    const missing = payload.states.find((state) => state.stateName === "Missing");
    assert.ok(missing);
    assert.match(
      missing.headError ?? "",
      /^\[step_failed\] Interaction step failed: State "Missing", step 1 \(click text "No such element"\): no visible element matched within 3 s\./
    );
    assert.equal(missing.headFailureKind, "step_failed");
    assert.match(payload.headError ?? "", /^State "Missing": \[step_failed\]/);
    assert.deepEqual(run.repairCalls, [], "a library harness is never repaired");
  });
});
