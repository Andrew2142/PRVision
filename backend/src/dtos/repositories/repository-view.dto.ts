import { STATE_ALLOWANCE_DEFAULT } from "../../config-consts";
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
  /** 16 §14.2: how the harness library is built (D3). */
  libraryBuildMode: "grow" | "scan";
  /** 16 §14.2: maximum number of states per harness (D4). */
  stateAllowance: number;
}

/** POST /api/repositories response (16 §14.2): the view plus the scan started with libraryBuildMode "scan". */
export interface RepositoryCreateResponse extends RepositoryView {
  /** The scan job started with "scan"; null otherwise or when it could not start. */
  scanJobId: number | null;
  /** Why the scan could not start (the repository is still created). */
  scanStartError: string | null;
}

/** Maps a repository model to its response view. */
export function toRepositoryView(model: RepositoryModel): RepositoryView {
  const styles: unknown = model.globalStylePaths;
  const appRoot: unknown = model.appRoot;
  const viewport: unknown = model.renderViewport;
  const buildMode: unknown = model.libraryBuildMode;
  const allowance: unknown = model.stateAllowance;
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
    renderViewport: viewport === "tablet" || viewport === "mobile" ? viewport : "desktop",
    viteConfigPath: model.viteConfigPath ?? null,
    tsconfigPath: model.tsconfigPath ?? null,
    entryFilePath: model.entryFilePath ?? null,
    globalStylePaths: Array.isArray(styles) ? styles.filter((s): s is string => typeof s === "string") : [],
    lastDetectedAt: toIsoString(model.lastDetectedAt),
    createdAt: toIsoString(model.createdAt),
    libraryBuildMode: buildMode === "scan" ? "scan" : "grow",
    stateAllowance: typeof allowance === "number" ? allowance : STATE_ALLOWANCE_DEFAULT
  };
}
