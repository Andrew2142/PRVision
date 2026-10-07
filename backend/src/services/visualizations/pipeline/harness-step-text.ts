/**
 * Human-readable text of a scripted harness step (16 §14.5). Pure. Written by 16a so 16b (validator messages) and
 * 16e (`ComponentStateView.stepSummary`, shown by the live banners) can both import it.
 */
import type { HarnessStep, HarnessStepTarget } from "../../../types/harness-library";

/** Quoted strings longer than this are cut (16 §14.5). */
const QUOTED_MAX_CHARS = 60;
/** Length a cut string keeps before the "..." marker. */
const QUOTED_CUT_CHARS = 57;

/** `"<value>"`, cut to 57 characters plus `...` when longer than 60. */
function quote(value: string): string {
  const shown = value.length > QUOTED_MAX_CHARS ? `${value.slice(0, QUOTED_CUT_CHARS)}...` : value;
  return `"${shown}"`;
}

/**
 * Text of a step target: `button "Save"`, `text "Saved"`, `field labelled "Email"`, `field with placeholder "Search"`
 * or `test id "menu"`, plus ` (match <nth + 1>)` when `nth > 0`.
 */
export function describeStepTarget(target: HarnessStepTarget): string {
  let text: string;
  switch (target.by) {
    case "role":
      text = `${target.role} ${quote(target.name)}`;
      break;
    case "text":
      text = `text ${quote(target.text)}`;
      break;
    case "label":
      text = `field labelled ${quote(target.label)}`;
      break;
    case "placeholder":
      text = `field with placeholder ${quote(target.placeholder)}`;
      break;
    case "testId":
      text = `test id ${quote(target.testId)}`;
      break;
  }
  const nth = target.nth ?? 0;
  return nth > 0 ? `${text} (match ${nth + 1})` : text;
}

/**
 * One line describing a step, e.g. `Click button "More actions"`, `Type "abc" into textbox "Search"`,
 * `Press Escape`, `Wait for text "Saved"` (16 §14.5).
 *
 * @param step - A scripted step of a harness state.
 * @returns The exact display text of §14.5.
 */
export function describeStep(step: HarnessStep): string {
  switch (step.action) {
    case "click":
      return `Click ${describeStepTarget(step.target)}`;
    case "hover":
      return `Hover ${describeStepTarget(step.target)}`;
    case "focus":
      return `Focus ${describeStepTarget(step.target)}`;
    case "type":
      return `Type ${quote(step.text)} into ${describeStepTarget(step.target)}`;
    case "press":
      return step.target === undefined
        ? `Press ${step.key}`
        : `Press ${step.key} in ${describeStepTarget(step.target)}`;
    case "waitFor":
      return `Wait for ${describeStepTarget(step.target)}`;
  }
}
