import { type RepositoryView } from '../../core/models/repository.model';
import { appChips, frameworkLabel, toDetectedRows } from './repository-format';

const REPO: RepositoryView = {
  id: 3,
  name: 'my-shop',
  localPath: '/home/dev/projects/my-shop',
  githubOwner: 'acme',
  githubRepo: 'my-shop',
  defaultBranch: 'main',
  framework: 'react_vite',
  appRoot: '.',
  angularProject: null,
  angularBuildConfiguration: null,
  packageManager: 'pnpm',
  viteConfigPath: 'vite.config.ts',
  tsconfigPath: 'tsconfig.json',
  entryFilePath: 'src/main.tsx',
  globalStylePaths: ['/src/index.css', 'some-lib/dist/style.css'],
  lastDetectedAt: '2026-10-03T10:00:00Z',
  createdAt: '2026-10-01T10:00:00Z',
};

function byLabel(
  repo: RepositoryView,
  includeIdentity = false,
): Map<string, ReturnType<typeof toDetectedRows>[number]> {
  return new Map(toDetectedRows(repo, { includeIdentity }).map((r) => [r.label, r]));
}

describe('repository-format', () => {
  it('toDetectedRows includeIdentity adds Name and Path rows, false omits them', () => {
    const withIdentity = toDetectedRows(REPO, { includeIdentity: true }).map((r) => r.label);
    expect(withIdentity.slice(0, 2)).toEqual(['Name', 'Path']);
    expect(withIdentity).toEqual([
      'Name',
      'Path',
      'Framework',
      'Package manager',
      'Default branch',
      'GitHub',
      'Vite config',
      'tsconfig',
      'Entry file',
      'Global styles',
    ]);
    const without = toDetectedRows(REPO, { includeIdentity: false }).map((r) => r.label);
    expect(without).not.toContain('Name');
    expect(without).not.toContain('Path');
  });

  it('null viteConfigPath/tsconfigPath/entryFilePath render "Not found"', () => {
    const rows = byLabel({ ...REPO, viteConfigPath: null, tsconfigPath: null, entryFilePath: null });
    expect(rows.get('Vite config')?.value).toBe('Not found');
    expect(rows.get('tsconfig')?.value).toBe('Not found');
    expect(rows.get('Entry file')?.value).toBe('Not found');
  });

  it('missing Vite config and entry file are flagged warn', () => {
    const rows = byLabel({ ...REPO, viteConfigPath: null, tsconfigPath: null, entryFilePath: null });
    expect(rows.get('Vite config')?.warn).toBeTrue();
    expect(rows.get('Entry file')?.warn).toBeTrue();
    expect(rows.get('tsconfig')?.warn).toBeFalse();
    expect(byLabel(REPO).get('Vite config')?.warn).toBeFalse();
  });

  it('empty globalStylePaths render "None found"', () => {
    expect(byLabel({ ...REPO, globalStylePaths: [] }).get('Global styles')?.value).toBe('None found');
    expect(byLabel(REPO).get('Global styles')?.value).toBe('/src/index.css\nsome-lib/dist/style.css');
  });

  it('no GitHub remote renders "No GitHub remote (pull requests unavailable)"', () => {
    const rows = byLabel({ ...REPO, githubOwner: null, githubRepo: null });
    expect(rows.get('GitHub')?.value).toBe('No GitHub remote (pull requests unavailable)');
    expect(rows.get('GitHub')?.mono).toBeFalse();
    expect(byLabel(REPO).get('GitHub')?.value).toBe('acme/my-shop');
  });

  it('paths and refs are marked mono', () => {
    const rows = byLabel(REPO, true);
    for (const label of ['Path', 'Default branch', 'Vite config', 'tsconfig', 'Entry file', 'Global styles']) {
      expect(rows.get(label)?.mono).withContext(label).toBeTrue();
    }
    expect(rows.get('Name')?.mono).toBeFalse();
    expect(rows.get('Framework')?.mono).toBeFalse();
  });

  it('frameworkLabel react_vite → "React + Vite", angular → "Angular"', () => {
    expect(frameworkLabel('react_vite')).toBe('React + Vite');
    expect(frameworkLabel('angular')).toBe('Angular');
  });

  it('Angular apps add App root, Angular project and Build configuration rows and drop Vite config', () => {
    const angular: RepositoryView = {
      ...REPO,
      framework: 'angular',
      appRoot: 'src/tenant-frontend',
      angularProject: 'tenant-frontend',
      angularBuildConfiguration: 'development',
      viteConfigPath: null,
    };
    expect(toDetectedRows(angular, { includeIdentity: false }).map((r) => r.label)).toEqual([
      'Framework',
      'App root',
      'Angular project',
      'Build configuration',
      'Package manager',
      'Default branch',
      'GitHub',
      'tsconfig',
      'Entry file',
      'Global styles',
    ]);
    const rows = byLabel(angular);
    expect(rows.get('Framework')?.value).toBe('Angular');
    expect(rows.get('App root')?.value).toBe('src/tenant-frontend');
    expect(rows.get('App root')?.mono).toBeTrue();
    expect(rows.get('Angular project')?.value).toBe('tenant-frontend');
    expect(rows.get('Build configuration')?.value).toBe('development');
    expect(byLabel({ ...angular, angularBuildConfiguration: null }).get('Build configuration')?.value).toBe(
      'Base options (no development configuration)',
    );
  });

  it('App root is shown only when it is not "."', () => {
    expect(byLabel(REPO).has('App root')).toBeFalse();
  });

  it('appChips: framework, then app root (not "."), then the Angular project', () => {
    expect(appChips(REPO)).toEqual(['React + Vite']);
    expect(
      appChips({ framework: 'angular', appRoot: 'src/tenant-frontend', angularProject: 'tenant-frontend' }),
    ).toEqual(['Angular', 'app root: src/tenant-frontend', 'project: tenant-frontend']);
    expect(appChips({ framework: 'angular', appRoot: '.', angularProject: 'web' })).toEqual([
      'Angular',
      'project: web',
    ]);
  });
});
