import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Title } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { Subject, catchError, exhaustMap, filter, finalize, map, of, switchMap, tap } from 'rxjs';
import { type ApiError } from '../../../core/models/api-error.model';
import { type RepositoryView } from '../../../core/models/repository.model';
import { ApiService } from '../../../core/services/api.service';
import { ConfirmDialogService, GENERIC_POPUP_DIALOG_CONFIG } from '../../../core/services/confirm-dialog.service';
import { NotificationService } from '../../../core/services/notification.service';
import { setPageTitle } from '../../../core/services/page-title.strategy';
import { errorCopyFor } from '../../../core/utils/error-messages.util';
import { parseRouteId } from '../../../core/utils/route-params.util';
import { InlineAlertComponent } from '../../../shared/components/inline-alert/inline-alert.component';
import { LoadingSpinnerComponent } from '../../../shared/components/loading-spinner/loading-spinner.component';
import { NotFoundPageComponent } from '../../../shared/components/not-found-page/not-found-page.component';
import { PageHeaderComponent } from '../../../shared/components/page-header/page-header.component';
import { DetectionCardComponent } from '../components/detection-card/detection-card.component';
import {
  NewVisualizationDialogComponent,
  type NewVisualizationDialogData,
  type NewVisualizationDialogResult,
} from '../components/new-visualization-dialog/new-visualization-dialog.component';
import { RecentVisualizationsComponent } from '../components/recent-visualizations/recent-visualizations.component';
import { appChips } from '../repository-format';

/** `/repositories/:id`: detection, recent runs, and the New visualization dialog (13 §5.7, 00 §16). */
@Component({
  selector: 'app-repository-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './repository-detail.component.html',
  host: { class: 'flex flex-col gap-6' },
  imports: [
    PageHeaderComponent,
    InlineAlertComponent,
    LoadingSpinnerComponent,
    NotFoundPageComponent,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    DetectionCardComponent,
    RecentVisualizationsComponent,
  ],
})
export class RepositoryDetailComponent {
  readonly id = input.required<string>();
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly dialog = inject(MatDialog);
  private readonly notifications = inject(NotificationService);
  private readonly title = inject(Title);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly repositoryId = computed(() => parseRouteId(this.id()));
  protected readonly repository = signal<RepositoryView | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly notFound = signal(false);
  protected readonly redetecting = signal(false);
  protected readonly removing = signal(false);
  protected readonly githubUrl = computed(() => {
    const r = this.repository();
    const ok = (v: string | null): v is string => !!v && /^[\w.-]+$/.test(v);
    return r && ok(r.githubOwner) && ok(r.githubRepo) ? `https://github.com/${r.githubOwner}/${r.githubRepo}` : null;
  });
  protected readonly githubLabel = computed(() => {
    const r = this.repository();
    return r?.githubOwner && r.githubRepo ? `${r.githubOwner}/${r.githubRepo}` : '';
  });
  /** Framework, app root and Angular project chips (15 §5.9.1). */
  protected readonly appChips = computed(() => {
    const repo = this.repository();
    return repo ? appChips(repo) : [];
  });
  protected readonly defaultBranchLabel = computed(() => `default: ${this.repository()?.defaultBranch ?? ''}`);
  protected readonly loadErrorMessage = computed(() => {
    const e = this.loadError();
    return e ? errorCopyFor(e).message : '';
  });
  private readonly load$ = new Subject<number>();

  constructor() {
    // switchMap: navigating to another repository id cancels the previous load.
    this.load$
      .pipe(
        tap(() => {
          this.loading.set(true);
          this.loadError.set(null);
          this.notFound.set(false);
        }),
        switchMap((id) =>
          this.api.getRepository(id).pipe(
            map((repo) => ({ repo, error: null })),
            catchError((error: ApiError) => of({ repo: null, error })),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(({ repo, error }) => {
        this.loading.set(false);
        if (repo) {
          this.repository.set(repo);
          setPageTitle(this.title, repo.name);
        } else if (error.isNotFound) {
          this.repository.set(null);
          this.notFound.set(true);
        } else {
          this.loadError.set(error);
        }
      });
    effect(() => {
      const id = this.repositoryId();
      untracked(() => {
        if (id === null) {
          this.loading.set(false);
          this.repository.set(null);
          this.notFound.set(true);
        } else {
          if (this.repository()?.id !== id) this.repository.set(null);
          this.load$.next(id);
        }
      });
    });
  }

  protected retry(): void {
    const id = this.repositoryId();
    if (id !== null) this.load$.next(id);
  }

  /** Opens the Source → Select → Review stepper (00 §16); the launcher navigates to the new run on Start. */
  protected openNewVisualization(): void {
    const repo = this.repository();
    if (!repo) return;
    this.dialog.open<NewVisualizationDialogComponent, NewVisualizationDialogData, NewVisualizationDialogResult>(
      NewVisualizationDialogComponent,
      { ...GENERIC_POPUP_DIALOG_CONFIG, data: { repository: repo } },
    );
  }

  protected redetect(): void {
    const repo = this.repository();
    if (!repo || this.redetecting()) return;
    this.redetecting.set(true);
    this.api
      .redetectRepository(repo.id) // not silent: the interceptor toasts errors; the old values stay
      .pipe(
        finalize(() => {
          this.redetecting.set(false);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (updated) => {
          this.repository.set(updated);
          this.notifications.success('Detection refreshed');
        },
        error: () => undefined,
      });
  }

  protected remove(): void {
    const repo = this.repository();
    if (!repo || this.removing()) return;
    this.confirm
      .confirm({
        title: 'Remove repository?',
        message: `PRVision will forget "${repo.name}". Your local clone is not touched.`,
        confirmText: 'Remove repository',
        confirmColor: 'warn',
      })
      .pipe(
        filter(Boolean),
        exhaustMap(() => {
          this.removing.set(true);
          // not silent: a 409 conflict (run in progress) is toasted by the interceptor
          return this.api.removeRepository(repo.id).pipe(
            finalize(() => {
              this.removing.set(false);
            }),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.notifications.success('Repository removed');
          void this.router.navigate(['/repositories']);
        },
        error: () => undefined,
      });
  }
}
