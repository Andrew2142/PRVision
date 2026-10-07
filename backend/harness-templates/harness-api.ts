/*
 * PRVision React harness API (static template, sheet 16b).
 * Copied to <viteRoot>/.prvision-harness/harness-api.ts. AI-written harness modules import ONLY
 * definePrvisionHarness (and its types) from this file plus application code.
 */
import type { ComponentType, ReactElement, ReactNode } from "react";

export type PrvisionStepTarget =
  | { by: "role"; role: string; name: string; nth?: number }
  | { by: "text"; text: string; nth?: number }
  | { by: "label"; label: string; nth?: number }
  | { by: "placeholder"; placeholder: string; nth?: number }
  | { by: "testId"; testId: string; nth?: number };

export type PrvisionStepKey =
  | "Enter" | "Escape" | "Tab" | "Space" | "ArrowDown" | "ArrowUp" | "ArrowLeft" | "ArrowRight" | "Home" | "End";

export type PrvisionStep =
  | { action: "click"; target: PrvisionStepTarget }
  | { action: "hover"; target: PrvisionStepTarget }
  | { action: "focus"; target: PrvisionStepTarget }
  | { action: "type"; target: PrvisionStepTarget; text: string }
  | { action: "press"; key: PrvisionStepKey; target?: PrvisionStepTarget }
  | { action: "waitFor"; target: PrvisionStepTarget };

export interface PrvisionReactState {
  /** "Default" first; unique; ≤ 40 characters. */
  name: string;
  /** Rendered as a function component, so it may call hooks. */
  render: () => ReactElement;
  /** Scripted interaction run after the state settles. Never on Default. */
  steps?: PrvisionStep[];
}

export interface PrvisionReactHarness {
  /** Providers shared by every state. Receives the state's element as children. */
  wrapper?: ComponentType<{ children: ReactNode }>;
  states: PrvisionReactState[];
}

export interface PrvisionReactHarnessModule extends PrvisionReactHarness {
  readonly __prvisionHarness: 1;
}

export function definePrvisionHarness(harness: PrvisionReactHarness): PrvisionReactHarnessModule {
  return { ...harness, __prvisionHarness: 1 };
}
