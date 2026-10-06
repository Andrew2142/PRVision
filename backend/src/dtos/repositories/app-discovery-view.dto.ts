import type { RepositoryFramework } from "../../enums";

/** One app found in a repository (15 §5.4.5). */
export interface AppCandidateView {
  appRoot: string;
  framework: RepositoryFramework;
  angularProject: string | null;
  suggestedName: string;
  supported: boolean;
  reason: string | null;
  /** Id of the active row registered for this app, else null. */
  repositoryId: number | null;
}

/** Response of POST /api/repositories/detect-apps (15 §5.4.5). */
export interface AppDiscoveryView {
  rootPath: string;
  hint: string | null;
  apps: AppCandidateView[];
}

/** The discovery shape the view is built from (ProjectDetectionService's AppDiscovery, structurally). */
export interface AppDiscoverySource {
  rootPath: string;
  hint: string | null;
  apps: ReadonlyArray<Omit<AppCandidateView, "repositoryId">>;
}

/**
 * Maps a discovery result to its response view.
 *
 * @param discovery - Discovery result.
 * @param registeredId - Id of the active repository row for an app, or null.
 */
export function toAppDiscoveryView(
  discovery: AppDiscoverySource,
  registeredId: (app: Omit<AppCandidateView, "repositoryId">) => number | null
): AppDiscoveryView {
  return {
    rootPath: discovery.rootPath,
    hint: discovery.hint,
    apps: discovery.apps.map((app) => ({
      appRoot: app.appRoot,
      framework: app.framework,
      angularProject: app.angularProject,
      suggestedName: app.suggestedName,
      supported: app.supported,
      reason: app.reason,
      repositoryId: registeredId(app)
    }))
  };
}
