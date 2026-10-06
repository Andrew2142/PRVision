import { type RepositoryFramework } from '../../core/models/domain-enums.model';
import { type RepositoryView } from '../../core/models/repository.model';

/** One definition-list row for the add dialog and the detection card. */
export interface DetectedRow {
  label: string;
  value: string;
  /** Paths and refs render in the code font. */
  mono: boolean;
  /** Missing file that rendering likely needs (Vite config, entry file). */
  warn: boolean;
}

const FRAMEWORK_LABELS: Record<RepositoryFramework, string> = { react_vite: 'React + Vite', angular: 'Angular' };

export function frameworkLabel(framework: RepositoryFramework): string {
  return FRAMEWORK_LABELS[framework];
}

/** "owner/repo", or null when the clone has no GitHub remote. */
export function githubSlug(repo: Pick<RepositoryView, 'githubOwner' | 'githubRepo'>): string | null {
  return repo.githubOwner && repo.githubRepo ? `${repo.githubOwner}/${repo.githubRepo}` : null;
}

/**
 * Rows from 13 §5.6 (dialog, `includeIdentity: true`) and §5.7.3 (detection card, without Name and Path), plus the
 * app root and Angular rows of 15 §5.4.7.
 */
export function toDetectedRows(repo: RepositoryView, options: { includeIdentity: boolean }): DetectedRow[] {
  const rows: DetectedRow[] = [];
  if (options.includeIdentity) {
    rows.push(row('Name', repo.name), row('Path', repo.localPath, true));
  }
  const slug = githubSlug(repo);
  const angular = repo.framework === 'angular';
  rows.push(row('Framework', frameworkLabel(repo.framework)));
  if (repo.appRoot !== '.') rows.push(row('App root', repo.appRoot, true));
  if (angular) {
    rows.push(
      row('Angular project', repo.angularProject ?? 'Unknown', true),
      row('Build configuration', repo.angularBuildConfiguration ?? 'Base options (no development configuration)'),
    );
  }
  rows.push(
    row('Package manager', repo.packageManager),
    row('Default branch', repo.defaultBranch, true),
    slug ? row('GitHub', slug, true) : row('GitHub', 'No GitHub remote (pull requests unavailable)'),
  );
  // Angular builds through angular.json, so there is no Vite config to report.
  if (!angular) rows.push(fileRow('Vite config', repo.viteConfigPath, true));
  rows.push(
    fileRow('tsconfig', repo.tsconfigPath, false),
    fileRow('Entry file', repo.entryFilePath, true),
    repo.globalStylePaths.length
      ? row('Global styles', repo.globalStylePaths.join('\n'), true)
      : row('Global styles', 'None found'),
  );
  return rows;
}

function row(label: string, value: string, mono = false): DetectedRow {
  return { label, value, mono, warn: false };
}

function fileRow(label: string, path: string | null, warnWhenMissing: boolean): DetectedRow {
  return path ? row(label, path, true) : { label, value: 'Not found', mono: false, warn: warnWhenMissing };
}

/** Header chips of an app (15 §5.9.1): framework, then the app root when not the repository root, then the project. */
export function appChips(repo: Pick<RepositoryView, 'framework' | 'appRoot' | 'angularProject'>): string[] {
  const chips = [frameworkLabel(repo.framework)];
  if (repo.appRoot !== '.') chips.push(`app root: ${repo.appRoot}`);
  if (repo.framework === 'angular' && repo.angularProject) chips.push(`project: ${repo.angularProject}`);
  return chips;
}
