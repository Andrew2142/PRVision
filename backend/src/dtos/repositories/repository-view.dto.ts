import type { PackageManager, RepositoryFramework } from "../../enums";
import type { RepositoryModel } from "../../models";
import { toIsoString } from "../../utilities/helpers/date";

/** Response view of one registered repository (00 §9). */
export interface RepositoryView {
  id: number;
  /** Screen size screenshots are taken at. */
  renderViewport: "desktop" | "tablet" | "mobile";
  name: string;
  localPath: string;
  githubOwner: string | null;
  githubRepo: string | null;
  defaultBranch: string;
  framework: RepositoryFramework;
  packageManager: PackageManager;
  /** Repo-relative app folder; "." = repository root (15 §5.4.5). */
  appRoot: string;
  angularProject: string | null;
  angularBuildConfiguration: string | null;
  viteConfigPath: string | null;
  tsconfigPath: string | null;
  entryFilePath: string | null;
  globalStylePaths: string[];
  lastDetectedAt: string;
  createdAt: string;
}

/** Maps a repository model to its response view. */
export function toRepositoryView(model: RepositoryModel): RepositoryView {
  const styles: unknown = model.globalStylePaths;
  const appRoot: unknown = model.appRoot;
  return {
    id: model.id,
    name: model.name,
    localPath: model.localPath,
    githubOwner: model.githubOwner ?? null,
    githubRepo: model.githubRepo ?? null,
    defaultBranch: model.defaultBranch,
    framework: model.framework,
    packageManager: model.packageManager,
    appRoot: typeof appRoot === "string" && appRoot !== "" ? appRoot : ".",
    angularProject: model.angularProject ?? null,
    angularBuildConfiguration: model.angularBuildConfiguration ?? null,
    renderViewport: model.renderViewport ?? "desktop",
    viteConfigPath: model.viteConfigPath ?? null,
    tsconfigPath: model.tsconfigPath ?? null,
    entryFilePath: model.entryFilePath ?? null,
    globalStylePaths: Array.isArray(styles) ? styles.filter((s): s is string => typeof s === "string") : [],
    lastDetectedAt: toIsoString(model.lastDetectedAt),
    createdAt: toIsoString(model.createdAt)
  };
}
