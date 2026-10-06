import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterLink } from '@angular/router';
import { Subject, catchError, debounceTime, exhaustMap, finalize, forkJoin, map, of, switchMap, tap } from 'rxjs';
import {
  COMMIT_PAGE_SIZE,
  COMMIT_SEARCH_DEBOUNCE_MS,
  COMMIT_SEARCH_LIMIT,
} from '../../../../core/constants/ui.constants';
import { type ApiError } from '../../../../core/models/api-error.model';
import {
  type BranchListView,
  type CommitView,
  type PullRequestView,
  type RepositoryView,
} from '../../../../core/models/repository.model';
import { type SettingsView } from '../../../../core/models/settings.model';
import { type VisualizationCreateRequest } from '../../../../core/models/visualization.model';
import { ApiService } from '../../../../core/services/api.service';
import { VisualizationLauncherService } from '../../../../core/services/visualization-launcher.service';
import { errorCopyFor } from '../../../../core/utils/error-messages.util';
import { isSafeGithubUrl } from '../../../../core/utils/labels.util';
import { EmptyStateComponent } from '../../../../shared/components/empty-state/empty-state.component';
import {
  GenericPopupComponent,
  type PopupConfig,
} from '../../../../shared/components/generic-popup/generic-popup.component';
import {
  InlineAlertComponent,
  type InlineAlertTone,
} from '../../../../shared/components/inline-alert/inline-alert.component';
import { LoadingSpinnerComponent } from '../../../../shared/components/loading-spinner/loading-spinner.component';
import { DateTimePipe } from '../../../../shared/pipes/date-time.pipe';
import { RelativeTimePipe } from '../../../../shared/pipes/relative-time.pipe';

/** The four ways to start a visualization (00 §16). */
export type SourceKind = 'github_pr' | 'local_branch' | 'commit_range' | 'working_tree';

export interface NewVisualizationDialogData {
  repository: RepositoryView;
}

/** Closes with the new visualization id after the launcher navigated to it; undefined when cancelled. */
export type NewVisualizationDialogResult = number | undefined;

type Step = 0 | 1 | 2;

/** "Commits on a branch": one commit against its first parent (default, 00 §16.1), or a From/To range. */
export type CommitMode = 'single' | 'range';

/** Tooltip on a root commit, which has no parent to compare against (00 §16.1). */
export const ROOT_COMMIT_REASON = 'First commit, nothing to compare against';

interface SourceOption {
  kind: SourceKind;
  title: string;
  description: string;
  icon: string;
  /** One-line reason the option is unavailable, else null. */
  disabledReason: string | null;
}

interface ReviewRow {
  label: string;
  value: string;
  mono?: boolean;
}

/** Review headline for a single-commit pick. */
interface SingleCommitReview {
  shortSha: string;
  subject: string;
  isMerge: boolean;
}

interface PrErrorView {
  tone: InlineAlertTone;
  settings: boolean;
  title: string;
  message: string;
}

const DIALOG_WIDTH = 'min(760px, calc(100vw - 32px))';
const SHORT = 7;

export const STEP_LABELS = ['Source', 'Select', 'Review & start'] as const;

const SOURCE_COPY: Record<SourceKind, Pick<SourceOption, 'title' | 'description' | 'icon'>> = {
  github_pr: { title: 'Pull request', description: 'An open pull request on GitHub.', icon: 'merge' },
  local_branch: { title: 'Branch vs branch', description: 'A local branch against a base branch.', icon: 'call_split' },
  commit_range: {
    title: 'Commits on a branch',
    description: 'What one commit changed, or a range of commits.',
    icon: 'commit',
  },
  working_tree: {
    title: 'Uncommitted changes',
    description: 'Your edits against the checked-out commit.',
    icon: 'edit_note',
  },
};

const SOURCE_ORDER: readonly SourceKind[] = ['github_pr', 'local_branch', 'commit_range', 'working_tree'];

const short = (sha: string): string => sha.slice(0, SHORT);

/**
 * "New visualization" stepper (00 §16): Source → Select → Review & start, hosted in MatDialog with Uply's
 * generic-popup chrome. Start goes through VisualizationLauncherService, which navigates to the new run.
 */
@Component({
  selector: 'app-new-visualization-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    MatTooltipModule,
    GenericPopupComponent,
    InlineAlertComponent,
    EmptyStateComponent,
    LoadingSpinnerComponent,
    RelativeTimePipe,
    DateTimePipe,
  ],
  templateUrl: './new-visualization-dialog.component.html',
})
export class NewVisualizationDialogComponent {
  private readonly dialogRef =
    inject<MatDialogRef<NewVisualizationDialogComponent, NewVisualizationDialogResult>>(MatDialogRef);
  private readonly data = inject<NewVisualizationDialogData>(MAT_DIALOG_DATA);
  private readonly api = inject(ApiService);
  private readonly launcher = inject(VisualizationLauncherService);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly repository = this.data.repository;
  protected readonly stepLabels = STEP_LABELS;
  protected readonly step = signal<Step>(0);
  protected readonly source = signal<SourceKind | null>(null);
  protected readonly launching = signal(false);

  // ----- repository state (branches + settings), loaded on open -----
  protected readonly branches = signal<BranchListView | null>(null);
  protected readonly branchesError = signal<ApiError | null>(null);
  private readonly settings = signal<SettingsView | null>(null);
  protected readonly contextLoading = signal(true);

  // ----- pull requests -----
  protected readonly prs = signal<PullRequestView[] | null>(null);
  protected readonly prsLoading = signal(false);
  protected readonly prsError = signal<ApiError | null>(null);
  protected readonly selectedPr = signal<number | null>(null);

  // ----- branch vs branch -----
  protected readonly branchForm = this.fb.group({ head: this.fb.control(''), base: this.fb.control('') });
  private readonly branchValue = toSignal(this.branchForm.valueChanges.pipe(map(() => this.branchForm.getRawValue())), {
    initialValue: this.branchForm.getRawValue(),
  });

  // ----- commits on a branch -----
  protected readonly commitBranch = this.fb.control('');
  /** Screen size for this run; starts at the repository's screen size. */
  protected readonly screenSize = this.fb.control<'desktop' | 'tablet' | 'mobile'>(this.data.repository.renderViewport);
  private readonly commitBranchValue = toSignal(this.commitBranch.valueChanges, { initialValue: '' });
  protected readonly commits = signal<CommitView[]>([]);
  protected readonly commitsLoading = signal(false);
  protected readonly commitsError = signal<ApiError | null>(null);
  protected readonly hasMoreCommits = signal(false);
  protected readonly commitMode = signal<CommitMode>('single');
  protected readonly singleSha = signal<string | null>(null);
  protected readonly rootCommitReason = ROOT_COMMIT_REASON;
  protected readonly toSha = signal<string | null>(null);
  protected readonly fromSha = signal<string | null>(null);
  /** Commit search text (message, author or SHA prefix); empty lists the branch history page by page. */
  protected readonly commitSearch = this.fb.control('');
  protected readonly commitSearchText = toSignal(this.commitSearch.valueChanges.pipe(map((value) => value.trim())), {
    initialValue: '',
  });
  /** The search the shown list was loaded with ('' = plain history). */
  protected readonly activeSearch = signal('');
  protected readonly noMatchMessage = computed(
    () =>
      `Nothing on ${this.commitBranchValue()} matches "${this.activeSearch()}". Try part of the message, an author or a SHA.`,
  );
  private readonly loadCommits$ = new Subject<{ branch: string; q: string }>();
  private readonly loadMoreCommits$ = new Subject<void>();

  protected readonly hasRemote = !!this.repository.githubOwner && !!this.repository.githubRepo;

  protected readonly branchOptions = computed(() => {
    const b = this.branches();
    return b ? b.branches.map((name) => ({ name, checkedOut: name === b.current })) : [];
  });
  protected readonly currentBranchLabel = computed(() => this.branches()?.current ?? null);

  protected readonly sourceOptions = computed<SourceOption[]>(() =>
    SOURCE_ORDER.map((kind) => ({ kind, ...SOURCE_COPY[kind], disabledReason: this.disabledReason(kind) })),
  );
  private readonly selectedOption = computed(
    () => this.sourceOptions().find((option) => option.kind === this.source()) ?? null,
  );

  protected readonly branchHeadValue = computed(() => this.branchValue().head);
  protected readonly branchBaseValue = computed(() => this.branchValue().base);
  protected readonly sameBranch = computed(() => {
    const { head, base } = this.branchValue();
    return !!head && head === base;
  });

  protected readonly prErrorView = computed<PrErrorView | null>(() => {
    const e = this.prsError();
    if (!e) return null;
    const copy = errorCopyFor(e);
    const view = (tone: InlineAlertTone, settings: boolean): PrErrorView => ({
      tone,
      settings,
      title: copy.title,
      message: copy.message,
    });
    if (e.is('github_token_missing')) return view('warning', true);
    if (e.is('github_unauthorized')) return view('error', true);
    if (e.is('github_rate_limited') || e.is('github_unavailable')) return view('warning', false);
    return view('error', false);
  });
  protected readonly prRows = computed(() =>
    (this.prs() ?? []).map((pr) => ({ pr, safeUrl: isSafeGithubUrl(pr.url) ? pr.url : null })),
  );

  private readonly toIndex = computed(() => this.indexOf(this.toSha()));
  private readonly fromIndex = computed(() => this.indexOf(this.fromSha()));
  /**
   * One row per loaded commit: whether it is the single pick (a root commit can't be), and whether it may be picked as
   * To / From (To must be newer than From).
   */
  protected readonly commitRows = computed(() => {
    const to = this.toIndex();
    const from = this.fromIndex();
    const single = this.singleSha();
    return this.commits().map((commit, index) => ({
      commit,
      isSingle: commit.sha === single,
      singleDisabled: commit.parentSha === null,
      isTo: index === to,
      isFrom: index === from,
      inRange: to >= 0 && from >= 0 && index >= to && index < from,
      toDisabled: from >= 0 && index >= from,
      fromDisabled: to >= 0 ? index <= to : index === 0,
    }));
  });
  /** Commits that the range adds on top of From (From itself excluded). */
  protected readonly rangeSize = computed(() => {
    const to = this.toIndex();
    const from = this.fromIndex();
    return to >= 0 && from > to ? from - to : 0;
  });
  private readonly toCommit = computed(() => this.commits()[this.toIndex()] ?? null);
  private readonly fromCommit = computed(() => this.commits()[this.fromIndex()] ?? null);
  /** The single pick, only when it has a parent to compare against. */
  private readonly singleCommit = computed(() => {
    const sha = this.singleSha();
    const commit = sha === null ? null : (this.commits().find((c) => c.sha === sha) ?? null);
    return commit?.parentSha ? commit : null;
  });
  protected readonly singleParentShort = computed(() => {
    const parent = this.singleCommit()?.parentSha;
    return parent ? short(parent) : null;
  });

  /** Review headline "Changes made by <shortSha> · <subject>" for a single-commit pick, else null. */
  protected readonly singleReview = computed<SingleCommitReview | null>(() => {
    if (this.source() !== 'commit_range' || this.commitMode() !== 'single') return null;
    const commit = this.singleCommit();
    return commit ? { shortSha: commit.shortSha, subject: commit.subject, isMerge: commit.isMerge } : null;
  });

  /** True when step 2 has a complete, valid choice for the selected source. */
  protected readonly selectionValid = computed(() => {
    switch (this.source()) {
      case 'github_pr':
        return this.selectedPr() !== null && (this.prs() ?? []).some((pr) => pr.number === this.selectedPr());
      case 'local_branch': {
        const { head, base } = this.branchValue();
        return !!head && !!base && !this.sameBranch();
      }
      case 'commit_range':
        if (!this.commitBranchValue()) return false;
        return this.commitMode() === 'single' ? this.singleCommit() !== null : this.rangeSize() > 0;
      case 'working_tree':
        return this.branches()?.workingTreeDirty === true;
      case null:
        return false;
    }
  });

  protected readonly reviewRows = computed<ReviewRow[]>(() => {
    const repo = this.repository.name;
    switch (this.source()) {
      case 'github_pr': {
        const pr = (this.prs() ?? []).find((p) => p.number === this.selectedPr());
        return pr
          ? [
              { label: 'Source', value: 'Pull request' },
              { label: 'Pull request', value: `#${String(pr.number)} ${pr.title}` },
              { label: 'Compare', value: `${pr.headRef} → ${pr.baseRef}`, mono: true },
              { label: 'Author', value: pr.author },
              { label: 'Repository', value: repo },
            ]
          : [];
      }
      case 'local_branch': {
        const { head, base } = this.branchValue();
        return [
          { label: 'Source', value: 'Branch vs branch' },
          { label: 'Head', value: head, mono: true },
          { label: 'Base', value: `${base} (merge-base with ${head})`, mono: true },
          { label: 'Repository', value: repo },
        ];
      }
      case 'commit_range': {
        if (this.commitMode() === 'single') {
          const commit = this.singleCommit();
          const parent = commit?.parentSha;
          if (!commit || !parent) return [];
          return [
            { label: 'Source', value: 'One commit on a branch' },
            { label: 'Branch', value: this.commitBranchValue(), mono: true },
            { label: 'Commit', value: `${commit.shortSha} ${commit.subject}` },
            {
              label: 'Compared with',
              value: `${short(parent)} (${commit.isMerge ? 'its first parent' : 'its parent'})`,
              mono: true,
            },
            { label: 'Author', value: commit.authorName },
            { label: 'Repository', value: repo },
          ];
        }
        const to = this.toCommit();
        const from = this.fromCommit();
        if (!to || !from) return [];
        const n = this.rangeSize();
        return [
          { label: 'Source', value: 'Commits on a branch' },
          { label: 'Branch', value: this.commitBranchValue(), mono: true },
          { label: 'From (base)', value: `${from.shortSha} ${from.subject}` },
          { label: 'To (head)', value: `${to.shortSha} ${to.subject}` },
          { label: 'Commits compared', value: `${String(n)} commit${n === 1 ? '' : 's'}` },
          { label: 'Repository', value: repo },
        ];
      }
      case 'working_tree':
        return [
          { label: 'Source', value: 'Uncommitted changes' },
          { label: 'Base', value: `HEAD of ${this.currentBranchLabel() ?? 'detached HEAD'}`, mono: true },
          { label: 'Head', value: 'Working tree, including untracked files' },
          { label: 'Repository', value: repo },
        ];
      case null:
        return [];
    }
  });

  protected readonly popupConfig = computed<PopupConfig>(() => {
    const step = this.step();
    const base = { title: 'New visualization', icon: 'difference', width: DIALOG_WIDTH };
    if (step === 0) {
      const option = this.selectedOption();
      return {
        ...base,
        primaryButtonText: 'Next',
        secondaryButtonText: 'Cancel',
        primaryButtonDisabled: option?.disabledReason !== null,
      };
    }
    if (step === 1) {
      return {
        ...base,
        primaryButtonText: 'Next',
        secondaryButtonText: 'Back',
        primaryButtonDisabled: !this.selectionValid(),
      };
    }
    return {
      ...base,
      primaryButtonText: 'Start visualization',
      secondaryButtonText: 'Back',
      primaryButtonDisabled: !this.selectionValid(),
      loading: this.launching(),
    };
  });

  constructor() {
    this.loadContext();

    this.loadCommits$
      .pipe(
        tap(({ q }) => {
          this.activeSearch.set(q);
          this.commits.set([]);
          this.singleSha.set(null);
          this.toSha.set(null);
          this.fromSha.set(null);
          this.hasMoreCommits.set(false);
          this.commitsError.set(null);
          this.commitsLoading.set(true);
        }),
        // switchMap: picking another branch cancels the previous branch's request.
        switchMap(({ branch, q }) =>
          this.api
            .listCommits(
              this.repository.id,
              q ? { branch, limit: COMMIT_SEARCH_LIMIT, q } : { branch, limit: COMMIT_PAGE_SIZE },
            )
            .pipe(
              map((page) => ({ page, error: null })),
              catchError((error: ApiError) => of({ page: null, error })),
            ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(({ page, error }) => {
        this.commitsLoading.set(false);
        if (!page) {
          this.commitsError.set(error);
          return;
        }
        this.commits.set(page);
        // Search results are not paged; plain history pages with Load more.
        this.hasMoreCommits.set(!this.activeSearch() && page.length === COMMIT_PAGE_SIZE);
        // Single default: the newest commit that has a parent. Range default: the two newest commits.
        this.singleSha.set(page.find((commit) => commit.parentSha !== null)?.sha ?? null);
        this.toSha.set(page[0]?.sha ?? null);
        this.fromSha.set(page[1]?.sha ?? null);
      });

    this.loadMoreCommits$
      .pipe(
        // exhaustMap: extra clicks while a page is loading are ignored.
        exhaustMap(() => {
          const last = this.commits().at(-1);
          const branch = this.commitBranch.value;
          if (!last || !branch) return of(null);
          this.commitsLoading.set(true);
          return this.api.listCommits(this.repository.id, { branch, limit: COMMIT_PAGE_SIZE, before: last.sha }).pipe(
            tap({
              next: (page) => {
                this.commits.update((current) => [...current, ...page]);
                this.hasMoreCommits.set(page.length === COMMIT_PAGE_SIZE);
              },
              error: (e: ApiError) => {
                this.commitsError.set(e);
              },
            }),
            catchError(() => of(null)),
            finalize(() => {
              this.commitsLoading.set(false);
            }),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();

    this.commitBranch.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((branch) => {
      if (!branch) return;
      this.commitSearch.setValue('', { emitEvent: false }); // a new branch starts with its plain history
      this.loadCommits$.next({ branch, q: '' });
    });

    this.commitSearch.valueChanges
      .pipe(
        map((value) => value.trim()),
        debounceTime(COMMIT_SEARCH_DEBOUNCE_MS),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((q) => {
        const branch = this.commitBranch.value;
        if (branch && q !== this.activeSearch()) this.loadCommits$.next({ branch, q });
      });
  }

  // ----- step navigation -----

  protected chooseSource(kind: SourceKind): void {
    const option = this.sourceOptions().find((o) => o.kind === kind);
    if (option?.disabledReason !== null || this.launching()) return;
    this.source.set(kind);
  }

  protected onPrimary(): void {
    const step = this.step();
    if (step === 0) {
      const option = this.selectedOption();
      if (option?.disabledReason !== null) return;
      this.enterSelect(option.kind);
      this.step.set(1);
    } else if (step === 1) {
      if (this.selectionValid()) this.step.set(2);
    } else {
      this.start();
    }
  }

  protected onSecondary(): void {
    if (this.launching()) return;
    const step = this.step();
    if (step === 0) this.dialogRef.close(undefined);
    else this.step.set(step === 2 ? 1 : 0);
  }

  /** X, Escape and backdrop (generic-popup). Ignored while a start request is in flight. */
  protected onCloseRequested(): void {
    if (!this.launching()) this.dialogRef.close(undefined);
  }

  protected goToStep(target: number): void {
    // The header only navigates back to completed steps.
    if (this.launching() || target >= this.step()) return;
    this.step.set(target === 0 ? 0 : 1);
  }

  // ----- step 2 actions -----

  protected selectPr(prNumber: number): void {
    this.selectedPr.set(prNumber);
  }

  protected loadPullRequests(): void {
    if (this.prsLoading()) return;
    this.prsLoading.set(true);
    this.prsError.set(null);
    this.api
      .listPullRequests(this.repository.id)
      .pipe(
        finalize(() => {
          this.prsLoading.set(false);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (prs) => {
          this.prs.set(prs);
          if (!prs.some((pr) => pr.number === this.selectedPr())) this.selectedPr.set(prs[0]?.number ?? null);
        },
        error: (e: ApiError) => {
          this.prsError.set(e);
        },
      });
  }

  protected pickSingle(sha: string): void {
    const commit = this.commits().find((c) => c.sha === sha);
    if (commit?.parentSha) this.singleSha.set(sha);
  }

  protected setCommitMode(mode: CommitMode): void {
    if (!this.launching()) this.commitMode.set(mode);
  }

  protected pickTo(sha: string): void {
    const index = this.indexOf(sha);
    const from = this.fromIndex();
    if (index < 0 || (from >= 0 && index >= from)) return;
    this.toSha.set(sha);
  }

  protected pickFrom(sha: string): void {
    const index = this.indexOf(sha);
    const to = this.toIndex();
    if (index <= 0 || (to >= 0 && index <= to)) return;
    this.fromSha.set(sha);
  }

  protected loadMoreCommits(): void {
    this.loadMoreCommits$.next();
  }

  protected retryCommits(): void {
    const branch = this.commitBranch.value;
    if (branch) this.loadCommits$.next({ branch, q: this.commitSearch.value.trim() });
  }

  protected clearCommitSearch(): void {
    this.commitSearch.setValue('');
  }

  protected retryContext(): void {
    this.loadContext();
  }

  // ----- internals -----

  private disabledReason(kind: SourceKind): string | null {
    if (kind === 'github_pr') {
      if (!this.hasRemote) return 'No GitHub remote on this repository.';
      if (this.contextLoading()) return 'Checking GitHub settings…';
      const settings = this.settings();
      if (settings && !settings.hasGithubToken) return 'Add a GitHub token in Settings first.';
      return null;
    }
    if (this.contextLoading()) return 'Reading local branches…';
    const branches = this.branches();
    if (!branches) return 'Local branches could not be read.';
    switch (kind) {
      case 'local_branch':
        return branches.branches.length < 2 ? 'Needs at least two local branches.' : null;
      case 'commit_range':
        return branches.branches.length === 0 ? 'No local branches.' : null;
      case 'working_tree':
        return branches.workingTreeDirty ? null : 'Working tree is clean: there are no uncommitted changes.';
    }
  }

  private loadContext(): void {
    this.contextLoading.set(true);
    this.branchesError.set(null);
    forkJoin({
      branches: this.api.listBranches(this.repository.id).pipe(
        map((value) => ({ value, error: null })),
        catchError((error: ApiError) => of({ value: null, error })),
      ),
      // Only used to explain a disabled Pull request card; a failure never blocks the dialog.
      settings: this.api.getSettings().pipe(catchError(() => of(null))),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ branches, settings }) => {
        this.contextLoading.set(false);
        this.settings.set(settings);
        this.branchesError.set(branches.error);
        if (branches.value) this.applyBranches(branches.value);
      });
  }

  private applyBranches(list: BranchListView): void {
    const first = this.branches() === null;
    this.branches.set(list);
    // A source that became unavailable on a reload (e.g. the tree is clean now) is deselected.
    const selected = this.source();
    if (selected && this.disabledReason(selected) !== null) {
      this.source.set(null);
      this.step.set(0);
    }
    if (!first) return;
    const head =
      list.current && list.current !== list.defaultBranch
        ? list.current
        : (list.branches.find((name) => name !== list.defaultBranch) ?? list.defaultBranch);
    this.branchForm.setValue({ head, base: list.defaultBranch });
  }

  /** Runs once when step 2 opens for a source: loads what its pickers need. */
  private enterSelect(kind: SourceKind): void {
    if (kind === 'github_pr' && this.prs() === null) this.loadPullRequests();
    if (kind === 'commit_range' && !this.commitBranch.value) {
      const head = this.branchForm.controls.head.value;
      const initial = head !== '' ? head : (this.branches()?.defaultBranch ?? '');
      if (initial) this.commitBranch.setValue(initial); // valueChanges loads the first page
    }
  }

  private indexOf(sha: string | null): number {
    return sha === null ? -1 : this.commits().findIndex((commit) => commit.sha === sha);
  }

  private request(): { request: VisualizationCreateRequest; label: string } | null {
    const repositoryId = this.repository.id;
    switch (this.source()) {
      case 'github_pr': {
        const pr = (this.prs() ?? []).find((p) => p.number === this.selectedPr());
        return pr
          ? {
              request: { repositoryId, sourceType: 'github_pr', prNumber: pr.number },
              label: `PR #${String(pr.number)} · ${pr.title}`,
            }
          : null;
      }
      case 'local_branch': {
        const { head, base } = this.branchForm.getRawValue();
        return {
          request: { repositoryId, sourceType: 'local_branch', headRef: head, baseRef: base },
          label: `${head} vs ${base}`,
        };
      }
      case 'commit_range': {
        const branch = this.commitBranch.value;
        if (this.commitMode() === 'single') {
          const commit = this.singleCommit();
          const parent = commit?.parentSha;
          return commit && parent && branch
            ? {
                request: {
                  repositoryId,
                  sourceType: 'commit_range',
                  headRef: branch,
                  baseSha: parent,
                  headSha: commit.sha,
                },
                label: `${branch}: ${commit.shortSha} · ${commit.subject}`,
              }
            : null;
        }
        const to = this.toCommit();
        const from = this.fromCommit();
        return to && from && branch
          ? {
              request: {
                repositoryId,
                sourceType: 'commit_range',
                headRef: branch,
                baseSha: from.sha,
                headSha: to.sha,
              },
              label: `${branch}: ${short(from.sha)}…${short(to.sha)}`,
            }
          : null;
      }
      case 'working_tree':
        return {
          request: { repositoryId, sourceType: 'working_tree' },
          label: `working tree on ${this.currentBranchLabel() ?? 'HEAD'}`,
        };
      case null:
        return null;
    }
  }

  private start(): void {
    if (this.launching() || !this.selectionValid()) return;
    const built = this.request();
    if (!built) return;
    this.launching.set(true);
    this.launcher
      .launch({ ...built.request, renderViewport: this.screenSize.value }, built.label)
      .pipe(
        finalize(() => {
          this.launching.set(false);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((id) => {
        // null: the launcher already showed the error; stay open so the choice can be changed.
        if (id !== null) this.dialogRef.close(id);
        else if (this.source() === 'working_tree') this.loadContext();
      });
  }
}
