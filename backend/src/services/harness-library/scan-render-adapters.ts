/**
 * Render overrides of scans (16 §10.3, E13): screenshots go to a scratch folder of the job and results stay in
 * memory. Nothing here touches `artifacts/`, `ArtifactStore` (whose path pattern rejects visualization id 0) or a
 * `visualizations`/`visualization_components` row.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, LIBRARY_JOBS_DIR_NAME, MAX_STATE_ORDINALS } from "../../config-consts";
import { resolveInside } from "../../utilities";
import type {
  ComponentRenderPayload,
  ComponentRenderPersistence,
  RenderArtifactStore
} from "../visualizations/pipeline/render-service";

/** Folder of the scratch renders inside a job folder. */
export const SCAN_RENDERS_DIR_NAME = "renders";

const IMAGE_KINDS: readonly string[] = ["base", "head", "diff"];

/** `<dataDir>/library-jobs/<jobId>` (its own folder per job, 00 §21 item 2). */
export function libraryJobDir(dataDir: string, jobId: number): string {
  assertPositiveInteger(jobId, "job id");
  return resolveInside(dataDir, LIBRARY_JOBS_DIR_NAME, String(jobId));
}

function assertPositiveInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${what} ${String(value)}`);
  }
}

/**
 * RenderArtifactStore of one scan job: `(visualizationId 0, componentId, ordinal, kind)` →
 * `<dataDir>/library-jobs/<jobId>/renders/<componentId>/[s<ordinal>/]<kind>.png`. Relative paths are data-dir
 * relative and never start with `artifacts/`.
 */
export class ScanArtifactStore implements RenderArtifactStore {
  readonly rendersDir: string;

  constructor(
    readonly jobId: number,
    private readonly dataDir: string = DATA_DIR
  ) {
    this.rendersDir = resolveInside(libraryJobDir(dataDir, jobId), SCAN_RENDERS_DIR_NAME);
  }

  imagePaths(
    visualizationId: number,
    componentId: number,
    kind: string
  ): { absolutePath: string; relativePath: string } {
    return this.stateImagePaths(visualizationId, componentId, 0, kind);
  }

  async ensureComponentDir(visualizationId: number, componentId: number): Promise<void> {
    await this.ensureComponentStateDir(visualizationId, componentId, 0);
  }

  stateImagePaths(
    visualizationId: number,
    componentId: number,
    ordinal: number,
    kind: string
  ): { absolutePath: string; relativePath: string } {
    const segments = this.stateSegments(visualizationId, componentId, ordinal);
    if (!IMAGE_KINDS.includes(kind)) {
      throw new Error(`Invalid image kind ${kind}`);
    }
    const absolutePath = resolveInside(this.rendersDir, ...segments, `${kind}.png`);
    return { absolutePath, relativePath: path.relative(this.dataDir, absolutePath).split(path.sep).join("/") };
  }

  async ensureComponentStateDir(visualizationId: number, componentId: number, ordinal: number): Promise<void> {
    const dir = resolveInside(this.rendersDir, ...this.stateSegments(visualizationId, componentId, ordinal));
    await fs.mkdir(dir, { recursive: true });
  }

  /** Deletes every scratch render of the job (after each batch). Never throws for a missing folder. */
  async clear(): Promise<void> {
    await fs.rm(this.rendersDir, { recursive: true, force: true });
  }

  /** Deletes the whole job folder (`finally`). */
  async removeJobDir(): Promise<void> {
    await fs.rm(libraryJobDir(this.dataDir, this.jobId), { recursive: true, force: true });
  }

  private stateSegments(visualizationId: number, componentId: number, ordinal: number): string[] {
    if (visualizationId !== 0) {
      throw new Error(`Scan renders belong to visualization id 0, not ${String(visualizationId)}`);
    }
    assertPositiveInteger(componentId, "component id");
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= MAX_STATE_ORDINALS) {
      throw new Error(`Invalid state ordinal ${String(ordinal)}`);
    }
    return ordinal === 0 ? [String(componentId)] : [String(componentId), `s${String(ordinal)}`];
  }
}

/** ComponentRenderPersistence that keeps each payload in memory for the scan's save step (16 §10.4 step 7.5). */
export class InMemoryRenderPersistence implements ComponentRenderPersistence {
  private readonly payloads = new Map<number, ComponentRenderPayload>();

  saveRenderResult(componentId: number, payload: ComponentRenderPayload): Promise<void> {
    this.payloads.set(componentId, payload);
    return Promise.resolve();
  }

  /** The payload saved for a component (null when it never reached a page). */
  get(componentId: number): ComponentRenderPayload | null {
    return this.payloads.get(componentId) ?? null;
  }

  /** Forgets every payload (between batches). */
  clear(): void {
    this.payloads.clear();
  }
}
