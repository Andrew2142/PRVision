/**
 * User-facing console of a harness library job (`harness_library_job_events`, 16 §6.5, §18). Same rules as 07's
 * visualization console: every message is sanitized and redacted, mirrored to the log, and a write never throws.
 */
import { Table, type ConsoleLevel } from "../../enums";
import type { PipelineContext } from "../../types/visualization-pipeline";
import { QueryHandler, createLogger } from "../../utilities";
import { sanitizeConsoleMessage } from "../visualizations/visualization-console-service";

export class LibraryJobConsole {
  private readonly log = createLogger("library-job-console");

  constructor(
    private readonly jobId: number,
    private readonly queryHandler: Pick<QueryHandler, "insert"> = new QueryHandler()
  ) {}

  /** Appends an info event. */
  info(message: string): Promise<void> {
    return this.append("info", message);
  }

  /** Appends a warn event. */
  warn(message: string): Promise<void> {
    return this.append("warn", message);
  }

  /** Appends an error event. */
  error(message: string): Promise<void> {
    return this.append("error", message);
  }

  /**
   * Adapter for PipelineContext.console (00 §8): the pipeline's stage names are dropped (job events have no stage
   * column); the message is written as is.
   */
  asPipelineConsole(): PipelineContext["console"] {
    return {
      info: (_stage: string, message: string) => this.info(message),
      warn: (_stage: string, message: string) => this.warn(message),
      error: (_stage: string, message: string) => this.error(message)
    };
  }

  /** Never throws: a console write failure must not fail a job. */
  private async append(level: ConsoleLevel, message: string): Promise<void> {
    const clean = sanitizeConsoleMessage(message);
    this.log[level]({ event: "library.job.console.event", jobId: this.jobId, message: clean }, "Library job event");
    try {
      const result = await this.queryHandler.insert(
        { jobId: this.jobId, level, message: clean },
        Table.HARNESS_LIBRARY_JOB_EVENTS
      );
      if (result.status !== 200) {
        this.log.warn(
          { event: "library.job.console.insert_failed", jobId: this.jobId, status: result.status },
          "Library job event insert failed"
        );
      }
    } catch (error: unknown) {
      this.log.warn(
        { event: "library.job.console.insert_failed", jobId: this.jobId, err: error },
        "Library job event insert threw"
      );
    }
  }
}
