import { CONSOLE_MESSAGE_MAX_LENGTH } from "../../config-consts";
import { Table, type ConsoleLevel } from "../../enums";
import type { PipelineContext } from "../../types";
import { QueryHandler, createLogger, redactSecrets } from "../../utilities";

/** Max length of a console event stage (07 §5.5). */
const CONSOLE_STAGE_MAX_LENGTH = 64;

/**
 * User-facing progress events of one visualization (`visualization_console_events`, 07 §5.5). Every message is
 * sanitized and redacted centrally, whoever writes it (07 itself and sheets 08–11 through `ctx.console`), and is
 * mirrored to the log. Writes never throw: a console failure must not fail a pipeline step.
 */
export class VisualizationConsoleService {
  private readonly log = createLogger("visualization-console");

  constructor(
    private readonly visualizationId: number,
    private readonly queryHandler: Pick<QueryHandler, "insert"> = new QueryHandler()
  ) {}

  /** Appends an info event. */
  info(stage: string, message: string): Promise<void> {
    return this.append("info", stage, message);
  }

  /** Appends a warn event. */
  warn(stage: string, message: string): Promise<void> {
    return this.append("warn", stage, message);
  }

  /** Appends an error event. */
  error(stage: string, message: string): Promise<void> {
    return this.append("error", stage, message);
  }

  /** Adapter for PipelineContext.console (00 §8). */
  asPipelineConsole(): PipelineContext["console"] {
    return { info: this.info.bind(this), warn: this.warn.bind(this), error: this.error.bind(this) };
  }

  /** Never throws: a console write failure must not fail a pipeline step. */
  private async append(level: ConsoleLevel, stage: string, message: string): Promise<void> {
    const clean = sanitizeConsoleMessage(message);
    const safeStage = stage.slice(0, CONSOLE_STAGE_MAX_LENGTH);
    this.log[level](
      { event: "visualization.console.event", visualizationId: this.visualizationId, stage: safeStage, message: clean },
      "Console event"
    );
    try {
      const result = await this.queryHandler.insert(
        { visualizationId: this.visualizationId, level, stage: safeStage, message: clean },
        Table.VISUALIZATION_CONSOLE_EVENTS
      );
      if (result.status !== 200) {
        this.log.warn(
          {
            event: "visualization.console.insert_failed",
            visualizationId: this.visualizationId,
            status: result.status
          },
          "Console event insert failed"
        );
      }
    } catch (error: unknown) {
      this.log.warn(
        { event: "visualization.console.insert_failed", visualizationId: this.visualizationId, err: error },
        "Console event insert threw"
      );
    }
  }
}

// eslint-disable-next-line no-control-regex -- stripping ANSI escape sequences is the purpose of this pattern
const ANSI_ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]/g;
// eslint-disable-next-line no-control-regex -- stripping control characters (except \n and \t) is the purpose
const CONTROL_CHARACTERS = /[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * Strips ANSI escapes and control characters (keeps \n, \t), redacts secrets (04 redactSecrets) and caps the
 * result at CONSOLE_MESSAGE_MAX_LENGTH characters (truncated with "…").
 */
export function sanitizeConsoleMessage(message: string): string {
  const stripped = message.replace(ANSI_ESCAPES, "").replace(CONTROL_CHARACTERS, "");
  const redacted = redactSecrets(stripped);
  return redacted.length > CONSOLE_MESSAGE_MAX_LENGTH
    ? `${redacted.slice(0, CONSOLE_MESSAGE_MAX_LENGTH - 1)}…`
    : redacted;
}
