import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import {
  buildDeterminismInitScript,
  buildMarkStepTargetScript,
  buildSeededRandomSource,
  READ_HARNESS_STATE_SCRIPT,
  SETTLE_AFTER_STEPS_SCRIPT,
  scriptJson,
  toHarnessState,
  toStepMark
} from "../../../backend/src/services/visualizations/pipeline/render/page-scripts";

function readState(windowGlobals: Record<string, unknown>): ReturnType<typeof toHarnessState> {
  const raw: unknown = vm.runInNewContext(READ_HARNESS_STATE_SCRIPT, { window: windowGlobals });
  return toHarnessState(JSON.parse(JSON.stringify(raw)));
}

test("READ_HARNESS_STATE_SCRIPT returns state { name, names, steps } from __PRVISION_STATE__", () => {
  const steps = [{ action: "click", target: { by: "role", role: "button", name: "More actions" } }];
  const state = readState({
    __PRVISION_STATUS__: "ready",
    __PRVISION_READY__: true,
    __PRVISION_STATE__: { name: "Menu open", names: ["Default", "Overdue", "Menu open"], steps }
  });
  assert.deepEqual(state.state, { name: "Menu open", names: ["Default", "Overdue", "Menu open"], steps });
});

test("READ_HARNESS_STATE_SCRIPT reads null for pages without __PRVISION_STATE__ and bounds what a page reports", () => {
  assert.equal(readState({ __PRVISION_READY__: true }).state, null);
  assert.equal(readState({ __PRVISION_STATE__: { names: ["x"] } }).state, null, "a state without a name");
  const noisy = readState({
    __PRVISION_STATE__: {
      name: "S",
      names: [...Array.from({ length: 30 }, (_, index) => `N${String(index)}`), 7],
      steps: Array.from({ length: 40 }, () => ({ action: "waitFor", target: { by: "text", text: "x" } }))
    }
  });
  assert.ok(noisy.state);
  assert.equal(noisy.state.names.length, 10);
  assert.equal(noisy.state.steps.length, 20);
  // Values that cannot be cloned as JSON (functions) are dropped by the in-page copy.
  const odd = readState({ __PRVISION_STATE__: { name: "S", names: [], steps: [{ action: "click", fn: () => 1 }] } });
  assert.deepEqual(odd.state?.steps, [{ action: "click" }]);
  assert.equal(toHarnessState({ state: { name: 3 } }).state, null);
});

test("buildMarkStepTargetScript escapes its JSON argument and calls the page bridge", () => {
  const calls: unknown[][] = [];
  const target = { by: "text", text: 'He said "</script><img onerror=x>" \\   done' };
  const script = buildMarkStepTargetScript(target, "s0");
  assert.ok(!script.includes("</script>"), "no raw closing script tag");
  assert.ok(!script.includes(" "), "line separators are escaped");
  const result: unknown = vm.runInNewContext(script, {
    window: {
      __PRVISION_MARK_STEP_TARGET__: (...args: unknown[]) => {
        calls.push(args);
        return { found: true, count: 2 };
      }
    }
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls)),
    [[target, "s0"]],
    "the page receives exactly the target and token"
  );
  assert.deepEqual(toStepMark(JSON.parse(JSON.stringify(result))), { found: true, count: 2, bridge: true });
});

test("buildMarkStepTargetScript reports a page without the step bridge", () => {
  const result: unknown = vm.runInNewContext(buildMarkStepTargetScript({ by: "testId", testId: "x" }, "s1"), {
    window: {}
  });
  assert.deepEqual(toStepMark(JSON.parse(JSON.stringify(result))), { found: false, count: 0, bridge: false });
  assert.deepEqual(toStepMark("nonsense"), { found: false, count: 0, bridge: false });
});

test("scriptJson escapes <, U+2028 and U+2029 and stays valid JSON", () => {
  const value = { a: "<  >" };
  const text = scriptJson(value);
  assert.equal(text, '{"a":"\\u003c\\u2028\\u2029>"}');
  assert.deepEqual(JSON.parse(text), value);
});

test("SETTLE_AFTER_STEPS_SCRIPT awaits __PRVISION_SETTLE__ and resolves false without it", async () => {
  let settled = 0;
  const withSettle: unknown = await vm.runInNewContext(SETTLE_AFTER_STEPS_SCRIPT, {
    window: {
      __PRVISION_SETTLE__: async () => {
        settled += 1;
        await Promise.resolve();
      }
    }
  });
  assert.equal(withSettle, true);
  assert.equal(settled, 1);
  const without: unknown = await vm.runInNewContext(SETTLE_AFTER_STEPS_SCRIPT, { window: {} });
  assert.equal(without, false);
});

test("buildSeededRandomSource is the random generator of the determinism script", () => {
  const init = buildDeterminismInitScript(42);
  assert.ok(init.includes(buildSeededRandomSource(42)));
  const sequence = (source: string): number[] => {
    const sandbox = { Math: Object.create(Math) as Math & { random: () => number } };
    vm.runInNewContext(`(() => {\n${source}\n})();`, sandbox);
    return [sandbox.Math.random(), sandbox.Math.random(), sandbox.Math.random()];
  };
  assert.deepEqual(sequence(buildSeededRandomSource(42)), sequence(buildSeededRandomSource(42)));
  assert.notDeepEqual(sequence(buildSeededRandomSource(42)), sequence(buildSeededRandomSource(43)));
});
