/**
 * Sheet 11 test helpers (11 §9). PNG builders come from sheet 14's shared `png-fixtures.ts`; this file adds an
 * in-memory ArtifactStore, a recording QueryHandler (sheet 14's InMemoryQueryHandler) and render-result builders.
 * The AI fake is sheet 14's ScriptedAiProvider (through createPipelineContext), not a separate fakeAiProvider.
 */
import os from "node:os";
import path from "node:path";
import { Table } from "../../../../../backend/src/enums";
import type { RenderSideResult } from "../../../../../backend/src/types/visualization-pipeline";
import { ArtifactStore, type QueryHandler } from "../../../../../backend/src/utilities";
import {
  makeComponentRow,
  makeVisualizationRow,
  type ComponentRow,
  type VisualizationRow
} from "../../../helpers/factories";
import { InMemoryQueryHandler } from "../../../helpers/query-handler-stub";

export {
  COLORS,
  encodePng,
  decodePng,
  noisePng,
  pixelAt,
  solidPng,
  withRect,
  type Rgba
} from "../../../helpers/png-fixtures";

export const VISUALIZATION_ID = 1;

/** ArtifactStore whose read/write use a Map keyed by the dataDir-relative path. */
export class MemoryArtifactStore extends ArtifactStore {
  readonly files = new Map<string, Buffer>();
  readonly reads: string[] = [];
  failWrites = false;

  constructor(initial: Record<string, Buffer> = {}) {
    super(path.join(os.tmpdir(), "prvision-test-memory-artifacts"));
    for (const [key, value] of Object.entries(initial)) {
      this.files.set(key, value);
    }
  }

  override read(relativePath: string): Promise<Buffer> {
    this.reads.push(relativePath);
    const buffer = this.files.get(relativePath);
    if (buffer === undefined) {
      return Promise.reject(Object.assign(new Error(`ENOENT: ${relativePath}`), { code: "ENOENT" }));
    }
    return Promise.resolve(buffer);
  }

  override write(relativePath: string, data: Buffer | string): Promise<string> {
    if (this.failWrites) {
      return Promise.reject(Object.assign(new Error("EACCES: write refused"), { code: "EACCES" }));
    }
    this.files.set(relativePath, Buffer.from(data));
    return Promise.resolve(relativePath);
  }
}

/** An in-memory ArtifactStore preloaded with `initial`. */
export function memoryArtifactStore(initial: Record<string, Buffer> = {}): MemoryArtifactStore {
  return new MemoryArtifactStore(initial);
}

/** One recorded QueryHandler.update call. */
export interface RecordedUpdate {
  values: Record<string, unknown>;
  conditions: Record<string, unknown>;
  table: string;
}

/** InMemoryQueryHandler seeded with visualization 1 and the given component rows, exposing its updates. */
export class RecordingQueryHandler extends InMemoryQueryHandler {
  get updates(): RecordedUpdate[] {
    return this.callsFor("update").map((call) => ({
      values: call.args[0] as Record<string, unknown>,
      conditions: call.args[1] as Record<string, unknown>,
      table: call.table
    }));
  }

  /** Updates of one component row. */
  updatesFor(componentId: number): Array<Record<string, unknown>> {
    return this.updates
      .filter((update) => update.table === Table.VISUALIZATION_COMPONENTS && update.conditions.id === componentId)
      .map((update) => update.values);
  }

  /** Typed as the real QueryHandler for injection. */
  asQueryHandler(): QueryHandler {
    return this as unknown as QueryHandler;
  }
}

/** A RecordingQueryHandler holding visualization 1 and `components` (visualizationId defaults to 1). */
export function recordingQueryHandler(
  components: Array<Partial<ComponentRow>> = [],
  visualization: Partial<VisualizationRow> = {}
): RecordingQueryHandler {
  const db = new RecordingQueryHandler();
  db.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({
      id: VISUALIZATION_ID,
      status: "diffing",
      ...visualization
    })
  ]);
  db.seed(
    Table.VISUALIZATION_COMPONENTS,
    components.map((row, index) =>
      makeComponentRow({
        id: index + 1,
        visualizationId: VISUALIZATION_ID,
        filePath: `src/components/C${String(row.id ?? index + 1)}.tsx`,
        displayName: `C${String(row.id ?? index + 1)}`,
        rank: index,
        renderStatus: "rendered",
        ...row
      })
    )
  );
  return db;
}

/** "artifacts/1/<componentId>/<kind>.png". */
export function artifactPath(componentId: number, kind: "base" | "head" | "diff"): string {
  return `artifacts/${String(VISUALIZATION_ID)}/${String(componentId)}/${kind}.png`;
}

/** A successful render side with an image at the standard artifact path. */
export function okSide(
  side: "base" | "head",
  componentId: number,
  width = 100,
  height = 50,
  overrides: Partial<RenderSideResult> = {}
): RenderSideResult {
  return {
    side,
    ok: true,
    imagePath: artifactPath(componentId, side),
    width,
    height,
    error: null,
    consoleErrors: [],
    durationMs: 10,
    ...overrides
  };
}

/** A failed render side (no image). */
export function failedSide(side: "base" | "head", error = "Render failed"): RenderSideResult {
  return {
    side,
    ok: false,
    imagePath: null,
    width: null,
    height: null,
    error,
    consoleErrors: [],
    durationMs: 10
  };
}
