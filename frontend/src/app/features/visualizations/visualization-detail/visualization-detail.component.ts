import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { exhaustMap, filter } from 'rxjs';
import {
  type RepositoryFramework,
  type SourceType,
  type VisualizationStatus,
} from '../../../core/models/domain-enums.model';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { NotificationService } from '../../../core/services/notification.service';
import { setPageTitle } from '../../../core/services/page-title.strategy';
import { sourceLabel } from '../../../core/utils/labels.util';
import { parseRouteId } from '../../../core/utils/route-params.util';
import { PIPELINE_STAGES } from '../../../core/utils/visualization-status.util';

/** Default components per run and the most a user can choose (backend MAX_COMPONENTS / COMPONENT_LIMIT_MAX). */
const DEFAULT_COMPONENT_LIMIT = 12;
const MAX_COMPONENT_LIMIT = 100;

interface LimitChoice {
  total: number;
  all: number;
  title: string;
  message: string;
  allLabel: string;
  topLabel: string;
}
import { EmptyStateComponent } from '../../../shared/components/empty-state/empty-state.component';
import { InlineAlertComponent } from '../../../shared/components/inline-alert/inline-alert.component';
import { LoadingSpinnerComponent } from '../../../shared/components/loading-spinner/loading-spinner.component';
import { NotFoundPageComponent } from '../../../shared/components/not-found-page/not-found-page.component';
import { PageHeaderComponent } from '../../../shared/components/page-header/page-header.component';
import {
  type SegmentOption,
  SegmentedControlComponent,
} from '../../../shared/components/segmented-control/segmented-control.component';
import { StatusPillComponent } from '../../../shared/components/status-pill/status-pill.component';
import { ComponentCardComponent } from '../components/component-card/component-card.component';
import { ConsolePanelComponent } from '../components/console-panel/console-panel.component';
import { PipelineStepperComponent } from '../components/pipeline-stepper/pipeline-stepper.component';
import { SummaryCardComponent } from '../components/summary-card/summary-card.component';
import { frameworkChipLabel, noComponentsCopy, refWithSha, summaryLine } from '../visualization-format';
import { type ComponentFilter } from './component-filters';
import { type DetailView, defaultDetailView, parseDetailView } from './detail-views';
import { VisualizationDetailStore } from './visualization-detail.store';

const DEFAULT_ERROR_MESSAGE = 'The pipeline stopped with an error. See the console for details.';

interface DetailHeaderView {
  title: string;
  sourceType: SourceType;
  sourceLabel: string;
  repositoryId: number;
  repositoryName: string;
  framework: RepositoryFramework;
  frameworkLabel: string;
  refsBase: string;
  refsHead: string;
  status: VisualizationStatus;
  summaryLine: string;
  failedTitle: string | null;
  cancelledTitle: string | null;
  errorMessage: string;
  noComponentsTitle: string;
  noComponentsMessage: string;
}

/** Base and head refs for the header; one branch name when both sides are on the same branch. */
function refsParts(
  v: { sourceType: SourceType; baseRef: string; headRef: string; baseSha: string | null; headSha: string | null },
  head: string,
): { refsBase: string; refsHead: string } {
  if (v.sourceType !== 'working_tree' && v.baseRef === v.headRef && v.baseSha && v.headSha) {
    return { refsBase: `${v.baseRef} · ${v.baseSha.slice(0, 7)}`, refsHead: v.headSha.slice(0, 7) };
  }
  return { refsBase: refWithSha(v.baseRef, v.baseSha), refsHead: head };
}

/**
 * `/visualizations/:id`: live progress, console, AI summary and per-component results (13 §5.9). Revision 5: the
 * header and stepper stay on top; a tab selector (`?view=summary|components|console`) shows one section at a time.
 */
@Component({
  selector: 'app-visualization-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [VisualizationDetailStore],
  templateUrl: './visualization-detail.component.html',
  host: { class: 'flex flex-col gap-6' },
  imports: [
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatProgressSpinnerModule,
    PageHeaderComponent,
    StatusPillComponent,
    SegmentedControlComponent,
    InlineAlertComponent,
    LoadingSpinnerComponent,
    NotFoundPageComponent,
    EmptyStateComponent,
    PipelineStepperComponent,
    ConsolePanelComponent,
    SummaryCardComponent,
    ComponentCardComponent,
  ],
})
export class VisualizationDetailComponent {
  readonly id = input.required<string>();
  /** `?view=` query param (router input binding). Unknown values fall back to the default view. */
  readonly view = input<string>();
  protected readonly store = inject(VisualizationDetailStore);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly title = inject(Title);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly parsedId = computed(() => parseRouteId(this.id()));
  /** Everything the header and alerts print, derived once per detail change (no helper calls in the template). */
  protected readonly header = computed<DetailHeaderView | null>(() => {
    const v = this.store.detail();
    if (!v) return null;
    const stage = PIPELINE_STAGES[this.store.stoppedStageIndex()]?.label ?? null;
    const head = v.sourceType === 'working_tree' ? 'working tree' : refWithSha(v.headRef, v.headSha);
    return {
      title: v.title,
      sourceType: v.sourceType,
      sourceLabel: sourceLabel(v),
      repositoryId: v.repositoryId,
      repositoryName: v.repositoryName,
      framework: v.framework,
      frameworkLabel: frameworkChipLabel(v.framework),
      ...refsParts(v, head),
      status: v.status,
      summaryLine: summaryLine(v),
      failedTitle: v.status === 'failed' ? (stage ? `Failed during ${stage}` : 'Visualization failed') : null,
      cancelledTitle: v.status === 'cancelled' ? (stage ? `Cancelled during ${stage}` : 'Cancelled') : null,
      // An empty message falls back too (13 §5.9.4 uses `||`).
      errorMessage: v.errorMessage?.length ? v.errorMessage : DEFAULT_ERROR_MESSAGE,
      ...noComponentsCopy(v.status, v.framework),
    };
  });
  protected readonly filterOptions = computed<SegmentOption<ComponentFilter>[]>(() => {
    const c = this.store.counts();
    return [
      { value: 'changed', label: 'Changed', count: c.changed },
      { value: 'unchanged', label: 'Unchanged', count: c.unchanged },
      { value: 'failed', label: 'Failed', count: c.failed },
      { value: 'all', label: 'All', count: c.all },
    ];
  });
  protected readonly statTiles = computed(() => {
    const c = this.store.counts();
    return [
      { key: 'all', label: 'Components', value: c.all, icon: 'widgets' },
      { key: 'changed', label: 'Changed', value: c.changed, icon: 'difference' },
      { key: 'unchanged', label: 'Unchanged', value: c.unchanged, icon: 'check_circle' },
      { key: 'failed', label: 'Failed', value: c.failed, icon: 'error' },
    ];
  });
  /** The user's pick: follows `?view=` (reloads, links, back/forward) and is set at once on click. */
  private readonly chosenView = linkedSignal<DetailView | null>(() => parseDetailView(this.view()));
  protected readonly activeView = computed<DetailView>(
    () => this.chosenView() ?? defaultDetailView(this.store.status()),
  );
  protected readonly viewOptions = computed<SegmentOption<DetailView>[]>(() => [
    { value: 'components', label: 'Components', icon: 'widgets', count: this.store.counts().all },
    { value: 'summary', label: 'Summary', icon: 'auto_awesome' },
    { value: 'console', label: 'Console', icon: 'terminal' },
  ]);
  /** Set while the run is paused because analysis found more components than the default limit. */
  protected readonly limitChoice = computed<LimitChoice | null>(() => {
    const v = this.store.detail();
    if (v?.status !== 'awaiting_confirmation') return null;
    const total = v.componentCount;
    const all = Math.min(total, MAX_COMPONENT_LIMIT);
    return {
      total,
      all,
      title: `${String(total)} components changed`,
      message:
        `PRVision renders ${String(DEFAULT_COMPONENT_LIMIT)} components by default. Rendering ` +
        `${all === total ? 'all ' : ''}${String(all)} needs about ${String(all)} AI calls and takes longer. ` +
        'Nothing has used AI yet.',
      allLabel: all === total ? `Render all ${String(total)}` : `Render top ${String(all)}`,
      topLabel: `Render top ${String(DEFAULT_COMPONENT_LIMIT)}`,
    };
  });
  private promptedFor: number | null = null;
  protected readonly cancelLabel = computed(() => (this.store.cancelState() === 'idle' ? 'Cancel' : 'Cancelling…'));
  protected readonly summaryMarkdown = computed(() => this.store.detail()?.summaryMarkdown ?? null);
  protected readonly aiModel = computed(() => this.store.detail()?.aiModel ?? '');
  /** With no changed components the summary is a fixed text written without AI (11 §5.4). */
  protected readonly summaryByAi = computed(() => (this.store.detail()?.changedCount ?? 0) > 0);
  protected readonly loadErrorMessage = computed(() => this.store.loadError()?.message ?? '');

  constructor() {
    // Inputs are not readable in the constructor (NG0950): start the store from an effect on the parsed id.
    effect(() => {
      const id = this.parsedId();
      untracked(() => {
        if (id === null) this.store.markNotFound();
        else this.store.start(id);
      });
    });
    // Pop up the component-limit choice once per paused run; the inline alert keeps the same choices.
    effect(() => {
      const choice = this.limitChoice();
      const id = this.store.detail()?.id ?? null;
      if (!choice || id === null || this.promptedFor === id) return;
      this.promptedFor = id;
      untracked(() => {
        this.confirm
          .confirm({
            title: choice.title,
            message: `${choice.message} You can also render just the top ${String(DEFAULT_COMPONENT_LIMIT)}, or cancel the run.`,
            confirmText: choice.allLabel,
            cancelText: 'Decide below',
          })
          .pipe(filter(Boolean), takeUntilDestroyed(this.destroyRef))
          .subscribe(() => {
            this.store.continueRun(choice.all);
          });
      });
    });
    effect(() => {
      const t = this.store.detail()?.title;
      if (!t) return;
      untracked(() => {
        setPageTitle(this.title, t);
      });
    });
  }

  protected selectView(view: DetailView): void {
    this.chosenView.set(view);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { view },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  protected continueWith(componentLimit: number): void {
    this.store.continueRun(componentLimit);
  }

  protected readonly defaultComponentLimit = DEFAULT_COMPONENT_LIMIT;

  protected confirmCancel(): void {
    this.confirm
      .confirm({
        title: 'Cancel this visualization?',
        message: 'The pipeline stops at its next checkpoint. Components that already finished keep their results.',
        confirmText: 'Cancel visualization',
        cancelText: 'Keep running',
        confirmColor: 'warn',
      })
      .pipe(filter(Boolean), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.store.cancel();
      });
  }

  protected confirmDelete(): void {
    const title = this.store.detail()?.title ?? 'this visualization';
    this.confirm
      .confirm({
        title: 'Delete visualization?',
        message: `Screenshots, diffs and the summary for "${title}" will be deleted. This cannot be undone.`,
        confirmText: 'Delete',
        confirmColor: 'warn',
      })
      .pipe(
        filter(Boolean),
        exhaustMap(() => this.store.remove()),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((ok) => {
        if (!ok) return;
        this.notifications.success('Visualization deleted');
        void this.router.navigate(['/visualizations']);
      });
  }
}
