import { type LibraryBuildMode, type PackageManager, type RepositoryFramework } from './domain-enums.model';

export type RenderViewport = 'desktop' | 'tablet' | 'mobile';

export interface RepositoryView {
  id: number;
  /** Screen size screenshots are taken at. */
  renderViewport: RenderViewport;
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
  /** Grow the harness library as runs go, or the whole app was scanned (16 D3). */
  libraryBuildMode: LibraryBuildMode;
  /** Most states a harness may have, 1–5 (16 D4). */
  stateAllowance: number;
}

export interface PullRequestView {
  number: number;
  title: string;
  author: string;
  headRef: string;
  baseRef: string;
  updatedAt: string;
  draft: boolean;
  url: string;
}

export interface BranchListView {
  current: string | null;
  branches: string[];
  defaultBranch: string;
  workingTreeDirty: boolean;
}

/** One commit of GET /api/repositories/:id/commits, newest first (00 §16, §16.1). */
export interface CommitView {
  sha: string;
  /** First parent; null for a root commit. A single-commit pick compares parentSha → sha (00 §16.1). */
  parentSha: string | null;
  /** More than one parent: a single-commit pick shows everything the merge brought in. */
  isMerge: boolean;
  shortSha: string;
  subject: string;
  authorName: string;
  /** ISO 8601. */
  committedAt: string;
}

/** GET /api/repositories/:id/commits query: `limit` 1..200 (default 50); `before` is exclusive. */
export interface CommitListQuery {
  branch: string;
  limit?: number;
  before?: string;
  /** Message, author or SHA prefix search; replaces paging (00 §16). */
  q?: string;
}

/** POST /api/repositories (00 §14.4, 15 §5.4.5). A leading "~/" is expanded server-side. */
export interface RepositoryCreateRequest {
  localPath: string;
  name?: string;
  appRoot?: string;
  angularProject?: string;
  /** Omitted = guessed by the backend. */
  renderViewport?: RenderViewport;
  /** Default "grow" (16 §14.2). */
  libraryBuildMode?: LibraryBuildMode;
  /** Integer 1–5; default 3. */
  stateAllowance?: number;
  /** Only with "scan"; null = no cap; 0.5–10 000 dollars with 2 decimals. */
  scanSpendCapUsd?: number | null;
}

/** 201 of POST /api/repositories (16 §14.2). */
export interface RepositoryCreateResponse extends RepositoryView {
  /** The scan started with libraryBuildMode "scan". */
  scanJobId: number | null;
  /** Why the scan could not start; the repository is still created. */
  scanStartError: string | null;
}

/** PATCH /api/repositories/:id: at least one field. */
export interface RepositoryUpdateRequest {
  renderViewport?: RenderViewport;
  stateAllowance?: number;
}

/** POST /api/repositories/detect-apps (15 §5.4.5). */
export interface RepositoryDetectAppsRequest {
  localPath: string;
}

/** One app found in a repository (15 §5.4.5). */
export interface AppCandidateView {
  appRoot: string;
  framework: RepositoryFramework;
  angularProject: string | null;
  suggestedName: string;
  supported: boolean;
  reason: string | null;
  /** Id of the active registration of this app, else null. */
  repositoryId: number | null;
}

/** Response of POST /api/repositories/detect-apps (15 §5.4.5). */
export interface AppDiscoveryView {
  rootPath: string;
  hint: string | null;
  apps: AppCandidateView[];
}
