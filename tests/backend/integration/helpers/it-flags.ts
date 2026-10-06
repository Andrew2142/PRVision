/**
 * Integration-test gating (sheet 14 §5.8, 00 §14.10). Render ITs run with PRVISION_IT_RENDER=1 or the umbrella
 * PRVISION_INTEGRATION=1; real-AI ITs only with PRVISION_IT_AI=1 (costs money, never implied by the umbrella).
 */
export type ItFlag = "render" | "ai";

function enabled(flag: ItFlag): boolean {
  if (flag === "render") {
    return process.env.PRVISION_IT_RENDER === "1" || process.env.PRVISION_INTEGRATION === "1";
  }
  return process.env.PRVISION_IT_AI === "1";
}

/** Skip reason when a required flag is off: test(name, { skip: itSkip("render") }, fn). */
export function itSkip(...flags: ItFlag[]): string | false {
  const missing = flags.filter((flag) => !enabled(flag));
  if (missing.length === 0) {
    return false;
  }
  // 10 §9.9 expects exactly "set PRVISION_IT_RENDER=1 (needs Chromium and the fixture repo)" for the render gate.
  return `set ${missing
    .map((f) => (f === "render" ? "PRVISION_IT_RENDER=1 (needs Chromium and the fixture repo)" : "PRVISION_IT_AI=1"))
    .join(" ")}`;
}
