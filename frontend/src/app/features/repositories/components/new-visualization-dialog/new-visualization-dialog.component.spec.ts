import { ApplicationRef } from '@angular/core';
import { TestBed, fakeAsync, flush, tick } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { NEVER, Subject, of, throwError } from 'rxjs';
import {
  COMMIT_PAGE_SIZE,
  COMMIT_SEARCH_DEBOUNCE_MS,
  COMMIT_SEARCH_LIMIT,
} from '../../../../core/constants/ui.constants';
import { ApiError } from '../../../../core/models/api-error.model';
import {
  type BranchListView,
  type CommitView,
  type PullRequestView,
  type RepositoryView,
} from '../../../../core/models/repository.model';
import { type SettingsView } from '../../../../core/models/settings.model';
import { ApiService } from '../../../../core/services/api.service';
import { GENERIC_POPUP_DIALOG_CONFIG } from '../../../../core/services/confirm-dialog.service';
import { VisualizationLauncherService } from '../../../../core/services/visualization-launcher.service';
import {
  NewVisualizationDialogComponent,
  type NewVisualizationDialogData,
  type NewVisualizationDialogResult,
} from './new-visualization-dialog.component';

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
  globalStylePaths: [],
  lastDetectedAt: '2026-10-03T10:00:00Z',
  createdAt: '2026-10-01T10:00:00Z',
};

const NO_REMOTE: RepositoryView = { ...REPO, githubOwner: null, githubRepo: null };

function branches(overrides: Partial<BranchListView> = {}): BranchListView {
  return {
    current: 'feature/x',
    branches: ['feature/x', 'main', 'feature/y'],
    defaultBranch: 'main',
    workingTreeDirty: true,
    ...overrides,
  };
}

function settings(hasGithubToken = true): SettingsView {
  return {
    hasGithubToken,
    githubLogin: hasGithubToken ? 'octocat' : null,
    aiProvider: 'anthropic_api',
    hasAnthropicApiKey: false,
    aiModel: 'claude-opus-5-5',
    aiHarnessEffort: 'medium',
    aiSummaryEffort: 'low',
  };
}

function pr(number: number, overrides: Partial<PullRequestView> = {}): PullRequestView {
  return {
    number,
    title: `Fix ${String(number)}`,
    author: 'octocat',
    headRef: `fix/${String(number)}`,
    baseRef: 'main',
    updatedAt: '2026-10-03T10:00:00Z',
    draft: false,
    url: `https://github.com/acme/my-shop/pull/${String(number)}`,
    ...overrides,
  };
}

/**
 * `count` commits, newest first; commit n (1-based, oldest first) has a unique short sha starting with n in hex, and
 * its parent is commit n - 1. Commit 1 is the root (parentSha null).
 */
function commits(count: number, offset = 0): CommitView[] {
  const shaOf = (n: number): string => n.toString(16).padStart(4, '0').padEnd(40, 'a');
  return Array.from({ length: count }, (_, index) => {
    const n = offset + count - index;
    const sha = shaOf(n);
    return {
      sha,
      parentSha: n > 1 ? shaOf(n - 1) : null,
      isMerge: false,
      shortSha: sha.slice(0, 7),
      subject: `commit ${String(n)}`,
      authorName: 'Ada Lovelace',
      committedAt: '2026-10-03T10:00:00Z',
    };
  });
}

describe('NewVisualizationDialogComponent', () => {
  let appRef: ApplicationRef;
  let dialog: MatDialog;
  let api: jasmine.SpyObj<ApiService>;
  let launcher: jasmine.SpyObj<VisualizationLauncherService>;
  let closedWith: NewVisualizationDialogResult | null;

  beforeEach(() => {
    api = jasmine.createSpyObj<ApiService>('ApiService', [
      'listBranches',
      'getSettings',
      'listPullRequests',
      'listCommits',
    ]);
    launcher = jasmine.createSpyObj<VisualizationLauncherService>('VisualizationLauncherService', ['launch']);
    api.listBranches.and.returnValue(of(branches()));
    api.getSettings.and.returnValue(of(settings()));
    api.listPullRequests.and.returnValue(of([pr(42, { title: 'Fix cart totals' }), pr(43, { draft: true })]));
    api.listCommits.and.returnValue(of(commits(5)));
    TestBed.configureTestingModule({
      providers: [
        provideNoopAnimations(),
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: VisualizationLauncherService, useValue: launcher },
      ],
    });
    appRef = TestBed.inject(ApplicationRef);
    dialog = TestBed.inject(MatDialog);
    closedWith = null;
  });

  afterEach(() => {
    dialog.closeAll();
    document.body.style.overflow = '';
  });

  function settle(): void {
    appRef.tick();
    tick(10);
    appRef.tick();
    tick(0);
    appRef.tick();
  }

  function open(repository: RepositoryView = REPO): void {
    dialog
      .open<NewVisualizationDialogComponent, NewVisualizationDialogData, NewVisualizationDialogResult>(
        NewVisualizationDialogComponent,
        { ...GENERIC_POPUP_DIALOG_CONFIG, data: { repository } },
      )
      .afterClosed()
      .subscribe((result) => (closedWith = result));
    settle();
  }

  function host(): HTMLElement {
    const el = document.querySelector<HTMLElement>('app-new-visualization-dialog');
    if (!el) throw new Error('dialog not open');
    return el;
  }

  function text(): string {
    return host().textContent ?? '';
  }

  function primary(): HTMLButtonElement {
    const last = Array.from(host().querySelectorAll<HTMLButtonElement>('button[mat-flat-button]')).at(-1);
    if (!last) throw new Error('no primary button');
    return last;
  }

  function secondary(): HTMLButtonElement {
    const found = Array.from(host().querySelectorAll<HTMLButtonElement>('button[mat-stroked-button]')).find((b) =>
      ['Cancel', 'Back'].includes(b.textContent?.trim() ?? ''),
    );
    if (!found) throw new Error('no secondary button');
    return found;
  }

  function sourceInput(kind: string): HTMLInputElement {
    const input = host().querySelector<HTMLInputElement>(`[data-source="${kind}"] input[type="radio"]`);
    if (!input) throw new Error(`no source ${kind}`);
    return input;
  }

  function reasonOf(kind: string): string | null {
    return host().querySelector(`[data-source="${kind}"] [data-testid="disabled-reason"]`)?.textContent?.trim() ?? null;
  }

  function choose(kind: string): void {
    sourceInput(kind).click();
    settle();
  }

  function next(): void {
    primary().click();
    settle();
  }

  function commitRadio(column: 'to' | 'from', shortSha: string): HTMLInputElement {
    const input = host().querySelector<HTMLInputElement>(`tr[data-sha="${shortSha}"] input[name="nv-${column}"]`);
    if (!input) throw new Error(`no ${column} radio for ${shortSha}`);
    return input;
  }

  function singleRadio(shortSha: string): HTMLInputElement {
    const input = host().querySelector<HTMLInputElement>(`tr[data-sha="${shortSha}"] input[name="nv-single"]`);
    if (!input) throw new Error(`no single radio for ${shortSha}`);
    return input;
  }

  function modeToggle(): HTMLButtonElement {
    const toggle = host().querySelector<HTMLButtonElement>('[data-testid="commit-mode-toggle"]');
    if (!toggle) throw new Error('no commit mode toggle');
    return toggle;
  }

  function useRange(): void {
    expect(modeToggle().textContent?.trim()).toBe('Compare a range instead');
    modeToggle().click();
    settle();
  }

  function stepTestId(): string | null {
    return host().querySelector('[data-testid^="step-"]')?.getAttribute('data-testid') ?? null;
  }

  // ----- step 1: Source -----

  it('opens on the Source step with four cards, the header and Next disabled until a source is chosen', fakeAsync(() => {
    open();
    expect(stepTestId()).toBe('step-source');
    expect(text()).toContain('New visualization');
    const labels = Array.from(host().querySelectorAll('[data-testid="stepper"] li')).map((li) =>
      li.textContent?.trim(),
    );
    expect(labels).toEqual(['1 Source', '2 Select', '3 Review & start']);
    expect(Array.from(host().querySelectorAll('[data-source]')).map((e) => e.getAttribute('data-source'))).toEqual([
      'github_pr',
      'local_branch',
      'commit_range',
      'working_tree',
    ]);
    expect(api.listBranches.calls.allArgs()).toEqual([[3]]);
    expect(primary().textContent?.trim()).toBe('Next');
    expect(primary().disabled).toBeTrue();
    choose('local_branch');
    expect(primary().disabled).toBeFalse();
  }));

  it('disables Pull request without a GitHub remote and Uncommitted changes on a clean tree, with a reason', fakeAsync(() => {
    api.listBranches.and.returnValue(of(branches({ workingTreeDirty: false })));
    open(NO_REMOTE);
    expect(sourceInput('github_pr').disabled).toBeTrue();
    expect(reasonOf('github_pr')).toBe('No GitHub remote on this repository.');
    expect(sourceInput('working_tree').disabled).toBeTrue();
    expect(reasonOf('working_tree')).toBe('Working tree is clean: there are no uncommitted changes.');
    expect(sourceInput('local_branch').disabled).toBeFalse();
    expect(reasonOf('local_branch')).toBeNull();
    expect(sourceInput('commit_range').disabled).toBeFalse();
  }));

  it('disables Pull request without a GitHub token and Branch vs branch with a single branch', fakeAsync(() => {
    api.getSettings.and.returnValue(of(settings(false)));
    api.listBranches.and.returnValue(of(branches({ branches: ['main'], current: 'main' })));
    open();
    expect(reasonOf('github_pr')).toBe('Add a GitHub token in Settings first.');
    expect(reasonOf('local_branch')).toBe('Needs at least two local branches.');
    expect(reasonOf('commit_range')).toBeNull();
  }));

  it('a settings failure never blocks the Pull request card; a branches failure disables the local sources and offers Retry', fakeAsync(() => {
    api.getSettings.and.returnValue(throwError(() => new ApiError('down', 500, 'internal_error')));
    api.listBranches.and.returnValue(throwError(() => new ApiError('git failed: boom', 400, 'not_git_repo')));
    open();
    expect(reasonOf('github_pr')).toBeNull();
    expect(reasonOf('local_branch')).toBe('Local branches could not be read.');
    expect(text()).toContain("Couldn't read local branches");
    api.listBranches.and.returnValue(of(branches()));
    Array.from(host().querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Retry')
      ?.click();
    settle();
    expect(reasonOf('local_branch')).toBeNull();
  }));

  it('Cancel closes without a result', fakeAsync(() => {
    open();
    secondary().click();
    settle();
    flush();
    expect(closedWith).toBeUndefined();
  }));

  // ----- Pull request -----

  it('Pull request: lists PRs, preselects the first, reviews and starts github_pr through the launcher', fakeAsync(() => {
    launcher.launch.and.returnValue(of(77));
    open();
    choose('github_pr');
    next();
    expect(stepTestId()).toBe('step-select');
    expect(api.listPullRequests.calls.allArgs()).toEqual([[3]]);
    expect(text()).toContain('Fix cart totals');
    expect(text()).toContain('Draft');
    expect(text()).toContain('fix/42 → main');
    host().querySelector<HTMLInputElement>('[data-pr="43"] input')?.click();
    settle();
    host().querySelector<HTMLInputElement>('[data-pr="42"] input')?.click();
    settle();
    next();
    expect(stepTestId()).toBe('step-review');
    expect(text()).toContain('#42 Fix cart totals');
    expect(primary().textContent?.trim()).toBe('Start visualization');
    next();
    expect(launcher.launch.calls.allArgs()).toEqual([
      [{ repositoryId: 3, sourceType: 'github_pr', prNumber: 42 }, 'PR #42 · Fix cart totals'],
    ]);
    flush();
    expect(closedWith).toBe(77);
  }));

  it('Pull request: token missing links to Settings; rate limited offers Retry; empty list copy', fakeAsync(() => {
    api.listPullRequests.and.returnValue(throwError(() => new ApiError('m', 400, 'github_token_missing')));
    open();
    choose('github_pr');
    next();
    expect(text()).toContain('GitHub token needed');
    expect(host().querySelector('a[href="/settings"]')?.textContent?.trim()).toBe('Open settings');
    expect(primary().disabled).toBeTrue();

    api.listPullRequests.and.returnValue(throwError(() => new ApiError('m', 429, 'github_rate_limited')));
    host().querySelector<HTMLButtonElement>('button[aria-label="Refresh pull requests"]')?.click();
    settle();
    expect(text()).toContain('GitHub rate limit reached');
    api.listPullRequests.and.returnValue(of([]));
    Array.from(host().querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Retry')
      ?.click();
    settle();
    expect(text()).toContain('No open pull requests');
    expect(primary().disabled).toBeTrue();
  }));

  it('Pull request: hides the GitHub link for an unsafe URL', fakeAsync(() => {
    api.listPullRequests.and.returnValue(of([pr(1), pr(2, { url: 'javascript:alert(1)' })]));
    open();
    choose('github_pr');
    next();
    const links = Array.from(host().querySelectorAll<HTMLAnchorElement>('a[aria-label^="Open pull request"]'));
    expect(links.map((a) => a.getAttribute('aria-label'))).toEqual(['Open pull request #1 on GitHub']);
    expect(links[0]?.rel).toBe('noopener noreferrer');
  }));

  // ----- Branch vs branch -----

  it('Branch vs branch: defaults head to the checked-out branch and base to the default branch, then starts local_branch', fakeAsync(() => {
    launcher.launch.and.returnValue(of(9));
    open();
    choose('local_branch');
    next();
    expect(host().querySelector('[data-testid="head-select"]')?.textContent).toContain('feature/x');
    expect(host().querySelector('[data-testid="base-select"]')?.textContent).toContain('main');
    next();
    expect(text()).toContain('main (merge-base with feature/x)');
    next();
    expect(launcher.launch.calls.allArgs()).toEqual([
      [{ repositoryId: 3, sourceType: 'local_branch', headRef: 'feature/x', baseRef: 'main' }, 'feature/x vs main'],
    ]);
    flush();
  }));

  it('Branch vs branch: Next is disabled while head equals base', fakeAsync(() => {
    api.listBranches.and.returnValue(of(branches({ current: 'main', branches: ['main', 'feature/y'] })));
    open();
    choose('local_branch');
    next();
    expect(host().querySelector('[data-testid="head-select"]')?.textContent).toContain('feature/y');
    const component = dialog.openDialogs[0]?.componentInstance as unknown as {
      branchForm: { setValue(v: { head: string; base: string }): void };
    };
    component.branchForm.setValue({ head: 'main', base: 'main' });
    settle();
    expect(text()).toContain('Choose two different branches.');
    expect(primary().disabled).toBeTrue();
  }));

  // ----- Commits on a branch -----

  it('Commits (single, default): one radio per row, preselects the newest commit and starts it against its parent', fakeAsync(() => {
    launcher.launch.and.returnValue(of(12));
    const list = commits(5);
    api.listCommits.and.returnValue(of(list));
    open();
    choose('commit_range');
    next();
    expect(host().querySelector('[data-testid="commit-list"]')?.getAttribute('data-mode')).toBe('single');
    expect(host().querySelectorAll('input[name="nv-to"], input[name="nv-from"]').length).toBe(0);
    expect(host().querySelectorAll('input[name="nv-single"]').length).toBe(5);
    const sha = (i: number): string => list[i]?.shortSha ?? '';
    expect(singleRadio(sha(0)).checked).toBeTrue();
    expect(host().querySelector('[data-testid="range-summary"]')?.textContent).toContain(
      `compared with its parent ${sha(1)}`,
    );

    singleRadio(sha(2)).click();
    settle();
    expect(singleRadio(sha(2)).checked).toBeTrue();
    next();
    expect(stepTestId()).toBe('step-review');
    const headline = host().querySelector('[data-testid="review-headline"]')?.textContent?.replace(/\s+/g, ' ').trim();
    expect(headline).toBe(`Changes made by ${sha(2)} · commit 3`);
    expect(host().querySelector('[data-testid="merge-note"]')).toBeNull();
    expect(text()).toContain('Compared with');
    expect(text()).toContain(`${sha(3)} (its parent)`);
    next();
    expect(launcher.launch.calls.allArgs()).toEqual([
      [
        {
          repositoryId: 3,
          sourceType: 'commit_range',
          headRef: 'feature/x',
          baseSha: list[3]?.sha ?? '',
          headSha: list[2]?.sha ?? '',
        },
        `feature/x: ${sha(2)} · commit 3`,
      ],
    ]);
    flush();
    expect(closedWith).toBe(12);
  }));

  it('Commits (single): the root commit is disabled with a tooltip reason; a merge commit gets the first-parent note', fakeAsync(() => {
    const list = commits(3).map((c, i) => (i === 0 ? { ...c, isMerge: true, subject: 'Merge feature/y' } : c));
    api.listCommits.and.returnValue(of(list));
    open();
    choose('commit_range');
    next();
    const root = singleRadio(list[2]?.shortSha ?? '');
    expect(root.disabled).toBeTrue();
    expect(root.getAttribute('aria-label')).toContain('First commit, nothing to compare against');
    const component = dialog.openDialogs[0]?.componentInstance as unknown as { pickSingle(sha: string): void };
    component.pickSingle(list[2]?.sha ?? '');
    settle();
    expect(root.checked).toBeFalse();
    expect(singleRadio(list[0]?.shortSha ?? '').checked).toBeTrue();
    expect(host().querySelector(`tr[data-sha="${list[0]?.shortSha ?? ''}"]`)?.textContent).toContain('Merge');

    next();
    const headline = host().querySelector('[data-testid="review-headline"]')?.textContent?.replace(/\s+/g, ' ').trim();
    expect(headline).toContain(`Changes made by ${list[0]?.shortSha ?? ''} · Merge feature/y`);
    expect(host().querySelector('[data-testid="merge-note"]')?.textContent?.trim()).toBe(
      'Merge commit: compared with its first parent, so everything the merge brought in.',
    );
    expect(text()).toContain('(its first parent)');
  }));

  it('Commits (single): the root-commit tooltip shows on hover of its cell', fakeAsync(() => {
    api.listCommits.and.returnValue(of(commits(2)));
    open();
    choose('commit_range');
    next();
    const cells = Array.from(host().querySelectorAll<HTMLElement>('[data-testid="single-cell"]'));
    cells[1]?.dispatchEvent(new MouseEvent('mouseenter'));
    settle();
    tick(1000);
    appRef.tick();
    expect(document.querySelector('.mat-mdc-tooltip')?.textContent?.trim()).toBe(
      'First commit, nothing to compare against',
    );
    flush();
  }));

  it('Commits: the mode link toggles single and range pickers and keeps both selections; default is single', fakeAsync(() => {
    const list = commits(4);
    api.listCommits.and.returnValue(of(list));
    open();
    choose('commit_range');
    next();
    expect(text()).toContain('Pick a branch, then the commit whose changes you want to see.');
    singleRadio(list[1]?.shortSha ?? '').click();
    settle();
    useRange();
    expect(host().querySelector('[data-testid="commit-list"]')?.getAttribute('data-mode')).toBe('range');
    expect(modeToggle().textContent?.trim()).toBe('Pick a single commit');
    expect(host().querySelectorAll('input[name="nv-single"]').length).toBe(0);
    expect(commitRadio('to', list[0]?.shortSha ?? '').checked).toBeTrue();
    expect(host().querySelector('[data-testid="range-summary"]')?.textContent).toContain('Compares 1 commit.');
    next();
    expect(host().querySelector('[data-testid="review-headline"]')).toBeNull();
    expect(text()).toContain('Commits compared');
    secondary().click();
    settle();
    modeToggle().click();
    settle();
    expect(singleRadio(list[1]?.shortSha ?? '').checked).toBeTrue();
    next();
    expect(host().querySelector('[data-testid="review-headline"]')?.textContent).toContain(
      `Changes made by ${list[1]?.shortSha ?? ''}`,
    );
  }));

  it('Commits (range): loads the checked-out branch, preselects the two newest commits and starts commit_range', fakeAsync(() => {
    launcher.launch.and.returnValue(of(11));
    const list = commits(5);
    api.listCommits.and.returnValue(of(list));
    open();
    choose('commit_range');
    next();
    useRange();
    expect(api.listCommits.calls.allArgs()).toEqual([[3, { branch: 'feature/x', limit: COMMIT_PAGE_SIZE }]]);
    const rows = host().querySelectorAll('[data-testid="commit-list"] tbody tr');
    expect(rows.length).toBe(5);
    expect(rows[0]?.textContent).toContain(list[0]?.shortSha ?? '');
    expect(rows[0]?.textContent).toContain('commit 5');
    expect(rows[0]?.textContent).toContain('Ada Lovelace');
    expect(commitRadio('to', list[0]?.shortSha ?? '').checked).toBeTrue();
    expect(commitRadio('from', list[1]?.shortSha ?? '').checked).toBeTrue();
    expect(host().querySelector('[data-testid="range-summary"]')?.textContent).toContain('Compares 1 commit.');

    // Widen the range: From = the oldest commit.
    commitRadio('from', list[4]?.shortSha ?? '').click();
    settle();
    expect(host().querySelector('[data-testid="range-summary"]')?.textContent).toContain('Compares 4 commits.');
    next();
    expect(stepTestId()).toBe('step-review');
    expect(text()).toContain('Commits compared');
    expect(text()).toContain('4 commits');
    next();
    expect(launcher.launch.calls.allArgs()).toEqual([
      [
        {
          repositoryId: 3,
          sourceType: 'commit_range',
          headRef: 'feature/x',
          baseSha: list[4]?.sha ?? '',
          headSha: list[0]?.sha ?? '',
        },
        `feature/x: ${list[4]?.shortSha ?? ''}…${list[0]?.shortSha ?? ''}`,
      ],
    ]);
    flush();
    expect(closedWith).toBe(11);
  }));

  it('Commits (range): disallows invalid picks (From at or above To, To at or below From)', fakeAsync(() => {
    const list = commits(4);
    api.listCommits.and.returnValue(of(list));
    open();
    choose('commit_range');
    next();
    useRange();
    const sha = (i: number): string => list[i]?.shortSha ?? '';
    // To = row 0, From = row 1.
    expect(commitRadio('from', sha(0)).disabled).toBeTrue();
    expect(commitRadio('to', sha(1)).disabled).toBeTrue();
    expect(commitRadio('to', sha(3)).disabled).toBeTrue();
    commitRadio('from', sha(3)).click();
    settle();
    commitRadio('to', sha(2)).click();
    settle();
    expect(commitRadio('to', sha(2)).checked).toBeTrue();
    expect(commitRadio('from', sha(2)).disabled).toBeTrue();
    expect(commitRadio('from', sha(1)).disabled).toBeTrue();
    expect(commitRadio('from', sha(3)).disabled).toBeFalse();
    expect(host().querySelector('[data-testid="range-summary"]')?.textContent).toContain('Compares 1 commit.');
    expect(primary().disabled).toBeFalse();
  }));

  it('Commits: Load more requests the next page with before = the last loaded sha and appends it', fakeAsync(() => {
    const first = commits(COMMIT_PAGE_SIZE, 10);
    const second = commits(10);
    api.listCommits.and.returnValues(of(first), of(second));
    open();
    choose('commit_range');
    next();
    const more = host().querySelector<HTMLButtonElement>('[data-testid="load-more"]');
    expect(more).not.toBeNull();
    more?.click();
    settle();
    expect(api.listCommits.calls.mostRecent().args).toEqual([
      3,
      { branch: 'feature/x', limit: COMMIT_PAGE_SIZE, before: first.at(-1)?.sha ?? '' },
    ]);
    expect(host().querySelectorAll('[data-testid="commit-list"] tbody tr').length).toBe(COMMIT_PAGE_SIZE + 10);
    expect(host().querySelector('[data-testid="load-more"]')).toBeNull();
  }));

  it('Commits: search sends q after a debounce, lists matches without Load more, and clearing restores the history', fakeAsync(() => {
    const page = commits(COMMIT_PAGE_SIZE, 10);
    api.listCommits.and.returnValues(of(page), of(commits(2, 100)), of([]), of(page));
    open();
    choose('commit_range');
    next();
    const input = host().querySelector<HTMLInputElement>('[data-testid="commit-search"]');
    expect(input).not.toBeNull();
    if (!input) return;

    input.value = ' sidebar ';
    input.dispatchEvent(new Event('input'));
    tick(COMMIT_SEARCH_DEBOUNCE_MS);
    settle();
    expect(api.listCommits.calls.mostRecent().args).toEqual([
      3,
      { branch: 'feature/x', limit: COMMIT_SEARCH_LIMIT, q: 'sidebar' },
    ]);
    expect(host().querySelectorAll('[data-testid="commit-list"] tbody tr').length).toBe(2);
    expect(host().querySelector('[data-testid="load-more"]')).toBeNull();

    input.value = 'nothing';
    input.dispatchEvent(new Event('input'));
    tick(COMMIT_SEARCH_DEBOUNCE_MS);
    settle();
    expect(host().querySelector('[data-testid="commit-search-empty"]')?.textContent).toContain('matches "nothing"');
    expect(primary().disabled).toBeTrue();

    host().querySelector<HTMLButtonElement>('[data-testid="commit-search-clear"]')?.click();
    tick(COMMIT_SEARCH_DEBOUNCE_MS);
    settle();
    expect(api.listCommits.calls.mostRecent().args).toEqual([3, { branch: 'feature/x', limit: COMMIT_PAGE_SIZE }]);
    expect(host().querySelector('[data-testid="load-more"]')).not.toBeNull();
  }));

  it('Commits: switching branch reloads; a single-commit branch cannot be compared; errors offer Retry', fakeAsync(() => {
    api.listCommits.and.returnValue(of(commits(1)));
    open();
    choose('commit_range');
    next();
    expect(text()).toContain('Only one commit');
    expect(primary().disabled).toBeTrue();

    api.listCommits.and.returnValue(
      throwError(() => new ApiError('Branch "x" does not exist', 400, 'validation_failed')),
    );
    const component = dialog.openDialogs[0]?.componentInstance as unknown as {
      commitBranch: { setValue(v: string): void };
    };
    component.commitBranch.setValue('feature/y');
    settle();
    expect(api.listCommits.calls.mostRecent().args[1]).toEqual({ branch: 'feature/y', limit: COMMIT_PAGE_SIZE });
    expect(text()).toContain("Couldn't load commits");
    api.listCommits.and.returnValue(of(commits(3)));
    Array.from(host().querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Retry')
      ?.click();
    settle();
    expect(host().querySelectorAll('[data-testid="commit-list"] tbody tr').length).toBe(3);
    expect(primary().disabled).toBeFalse();
  }));

  it('Commits: shows a spinner while the first page loads', fakeAsync(() => {
    api.listCommits.and.returnValue(NEVER);
    open();
    choose('commit_range');
    next();
    expect(host().querySelector('app-loading-spinner')).not.toBeNull();
    expect(primary().disabled).toBeTrue();
  }));

  // ----- Uncommitted changes -----

  it('Uncommitted changes: explains what is compared and starts working_tree without refs', fakeAsync(() => {
    launcher.launch.and.returnValue(of(5));
    open();
    choose('working_tree');
    next();
    expect(host().querySelector('[data-testid="wt-subtitle"]')?.textContent?.trim()).toBe(
      'Uncommitted changes on feature/x',
    );
    next();
    next();
    expect(launcher.launch.calls.allArgs()).toEqual([
      [{ repositoryId: 3, sourceType: 'working_tree' }, 'working tree on feature/x'],
    ]);
    flush();
    expect(closedWith).toBe(5);
  }));

  it('a failed start stays open; a clean tree on start reloads the branches and returns to Source', fakeAsync(() => {
    const result$ = new Subject<number | null>();
    launcher.launch.and.returnValue(result$);
    open();
    choose('working_tree');
    next();
    next();
    next();
    expect(primary().disabled).toBeTrue(); // loading while the request is in flight
    secondary().click();
    settle();
    expect(stepTestId()).toBe('step-review');
    api.listBranches.and.returnValue(of(branches({ workingTreeDirty: false })));
    result$.next(null);
    result$.complete();
    settle();
    expect(closedWith).toBeNull();
    expect(stepTestId()).toBe('step-source');
    expect(reasonOf('working_tree')).toContain('Working tree is clean');
  }));

  // ----- navigation -----

  it('Back returns to the previous step and keeps the choice; the header jumps back to completed steps only', fakeAsync(() => {
    open();
    choose('local_branch');
    next();
    next();
    expect(stepTestId()).toBe('step-review');
    secondary().click();
    settle();
    expect(stepTestId()).toBe('step-select');
    const header = Array.from(host().querySelectorAll<HTMLButtonElement>('[data-testid="stepper"] button'));
    expect(header[2]?.disabled).toBeTrue();
    header[0]?.click();
    settle();
    expect(stepTestId()).toBe('step-source');
    expect(sourceInput('local_branch').checked).toBeTrue();
  }));
});
