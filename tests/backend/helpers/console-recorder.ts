/**
 * Console-event and log capture for tests (sheet 14 §5.4.10). ConsoleRecorder implements PipelineContext.console;
 * recordLogger() subscribes to sheet 04's logTestStream, the only supported way to assert on logs (00 §14.10).
 */
import { VisualizationStatus } from "../../../backend/src/enums";
import type { PipelineContext } from "../../../backend/src/types/visualization-pipeline";
import { logTestStream } from "../../../backend/src/utilities/loggers/logger";

export type ConsoleLevel = "info" | "warn" | "error";
export interface RecordedEvent {
  level: ConsoleLevel;
  stage: string;
  message: string;
}

type PipelineConsole = PipelineContext["console"];

/** In-memory PipelineContext.console with assertion helpers. */
export class ConsoleRecorder implements PipelineConsole {
  readonly events: RecordedEvent[] = [];

  info(stage: string, message: string): Promise<void> {
    this.events.push({ level: "info", stage, message });
    return Promise.resolve();
  }
  warn(stage: string, message: string): Promise<void> {
    this.events.push({ level: "warn", stage, message });
    return Promise.resolve();
  }
  error(stage: string, message: string): Promise<void> {
    this.events.push({ level: "error", stage, message });
    return Promise.resolve();
  }

  /** Messages of every event, or of one level. */
  messages(level?: ConsoleLevel): string[] {
    return this.events.filter((e) => !level || e.level === level).map((e) => e.message);
  }

  /** True when an event of `level` (and `stage`, when given) contains `pattern` / matches the RegExp. */
  has(level: ConsoleLevel, pattern: string | RegExp, stage?: string): boolean {
    return this.events.some(
      (e) =>
        e.level === level &&
        (!stage || e.stage === stage) &&
        (typeof pattern === "string" ? e.message.includes(pattern) : pattern.test(e.message))
    );
  }

  /** Distinct stages in first-seen order. */
  stages(): string[] {
    return [...new Set(this.events.map((e) => e.stage))];
  }

  /** Throws listing every error-level event. */
  assertNoErrors(): void {
    const errors = this.events.filter((e) => e.level === "error");
    if (errors.length) {
      throw new Error(`Unexpected console errors:\n${errors.map((e) => `[${e.stage}] ${e.message}`).join("\n")}`);
    }
  }

  /** Asserts no event leaks a secret-looking value. */
  assertNoSecrets(secrets: string[]): void {
    for (const event of this.events) {
      for (const secret of secrets) {
        if (event.message.includes(secret)) {
          throw new Error(`Secret leaked into console event [${event.stage}]`);
        }
      }
    }
  }

  /** Console `stage` values are the pipeline status names (00 §14.4; 03 CHECKs them). */
  assertStagesAreStatusNames(): void {
    const allowed = new Set<string>(Object.values(VisualizationStatus));
    const bad = this.events.filter((e) => !allowed.has(e.stage));
    if (bad.length) {
      throw new Error(
        `Console stages that are not VisualizationStatus values: ${[...new Set(bad.map((e) => e.stage))].join(", ")}`
      );
    }
  }
}

/**
 * Captures every pino line (root and child loggers) for the duration of a test. The only supported way to
 * assert on logs (00 §14.10): under NODE_ENV=test 04's root logger writes to logTestStream (04 §9.10), and
 * child loggers created at import time inherit that destination. Call restore() in t.after.
 */
export function recordLogger(): { lines: Array<Record<string, unknown>>; text(): string; restore: () => void } {
  const lines: Array<Record<string, unknown>> = [];
  const unsubscribe = logTestStream.subscribe((line: string) => {
    lines.push(JSON.parse(line) as Record<string, unknown>);
  });
  return { lines, text: () => lines.map((line) => JSON.stringify(line)).join("\n"), restore: unsubscribe };
}
