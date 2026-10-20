import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VisualizationDetailView } from "../dtos/visualizations/visualization-view.dto";
import { VisualizationModel } from "../models";
import { VisualizationsService } from "../services/visualizations/visualizations-service";
import { ArtifactStore } from "../utilities";

/** Bumped when report.json changes shape; the viewer refuses versions it does not know. */
export const REPORT_FORMAT_VERSION = 1;

/** report.json: the run as the visualization page shows it, with image paths relative to the report folder. */
export interface HeadlessReport {
  format: typeof REPORT_FORMAT_VERSION;
  generatedAt: string;
  repository: { name: string; path: string };
  visualization: VisualizationDetailView;
}

const ARTIFACT_URL = /^\/(artifacts\/\d+\/\d+\/(?:s\d+\/)?(?:base|head|diff)\.png)$/;

/** Turns every "/artifacts/…png" string into "artifacts/…png" so the report opens from any folder or host. */
function relativizeImages(value: unknown): unknown {
  if (typeof value === "string") {
    return ARTIFACT_URL.exec(value)?.[1] ?? value;
  }
  if (Array.isArray(value)) {
    return value.map(relativizeImages);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relativizeImages(item)]));
  }
  return value;
}

/**
 * Writes `<reportDir>/report.json` and copies the run's screenshots to `<reportDir>/artifacts/<id>/`.
 * The report is self-contained: nothing in it points at the engine's data folder.
 */
export async function exportReport(
  visualizationId: number,
  reportDir: string,
  repository: { name: string; path: string }
): Promise<HeadlessReport> {
  const model = new VisualizationModel();
  model.setId(visualizationId);
  const detail = await new VisualizationsService(model).get();
  if (detail.status !== 200 || !detail.data) {
    throw new Error(`Could not read run ${String(visualizationId)} for the report`);
  }
  const visualization = relativizeImages(detail.data) as VisualizationDetailView;

  await mkdir(reportDir, { recursive: true });
  const source = new ArtifactStore().visualizationArtifactsDir(visualizationId);
  await cp(source, path.join(reportDir, "artifacts", String(visualizationId)), { recursive: true, force: true }).catch(
    (error: unknown) => {
      // A run that rendered nothing has no artifacts folder; the report still lists its components.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  );
  const report: HeadlessReport = {
    format: REPORT_FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    repository,
    visualization
  };
  await writeFile(path.join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
