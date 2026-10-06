import { Clipboard } from '@angular/cdk/clipboard';
import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { type ConsoleEventView } from '../../../../core/models/visualization.model';
import { NotificationService } from '../../../../core/services/notification.service';
import { formatDateTime } from '../../../../shared/components/data-grid/data-grid-helpers';
import {
  type SegmentOption,
  SegmentedControlComponent,
} from '../../../../shared/components/segmented-control/segmented-control.component';
import { DateTimePipe } from '../../../../shared/pipes/date-time.pipe';

type LevelFilter = 'all' | 'issues';
const RENDER_STEP = 500;
const BOTTOM_SLACK_PX = 24;

/** Live pipeline console (13 §5.9.6): Uply run-detail expander around the Uply run-console terminal. */
@Component({
  selector: 'app-console-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, SegmentedControlComponent, DateTimePipe],
  host: { class: 'block' },
  template: `
    <details
      class="group overflow-hidden rounded-xl border border-[color:var(--color-border)] bg-[var(--color-bg-secondary)]"
      [open]="open()"
      (toggle)="onToggle($event)"
    >
      <summary class="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4">
        <div class="min-w-0">
          <div class="text-base font-semibold text-[var(--color-text-primary)]">Console</div>
          <div class="text-[0.86rem] text-[var(--color-text-tertiary)]">{{ subtitle() }}</div>
        </div>
        <div class="flex items-center gap-2">
          @if (live()) {
            <span class="dd-pill dd-pill--info"
              ><span class="dd-pill__dot dd-pill__dot--pulse" aria-hidden="true"></span>Live</span
            >
          } @else {
            <span class="dd-pill dd-pill--muted">Finished</span>
          }
          <mat-icon
            class="!h-4 !w-4 !text-base text-[var(--color-text-tertiary)] transition-transform group-open:rotate-180"
            aria-hidden="true"
            >expand_more</mat-icon
          >
        </div>
      </summary>
      <div class="flex flex-col gap-3 px-5 pb-5">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <app-segmented-control
            ariaLabel="Console level"
            [options]="levelOptions()"
            [value]="levelFilter()"
            (valueChange)="levelFilter.set($event)"
            [fullWidthOnMobile]="false"
          />
          <button mat-stroked-button type="button" class="!rounded-xl" (click)="copy()">
            <mat-icon aria-hidden="true">content_copy</mat-icon> Copy
          </button>
        </div>
        <div class="pv-console relative overflow-hidden rounded-2xl border border-[color:var(--color-border)]">
          @if (!rows().length) {
            <div class="grid min-h-48 place-items-center px-4 py-8 text-center text-sm">
              <div>
                <p class="font-display text-base font-semibold tracking-tight">{{ emptyTitle() }}</p>
                <p class="pv-console__subtle mt-2 text-sm">{{ emptyMessage() }}</p>
              </div>
            </div>
          } @else {
            <div
              #scroller
              class="max-h-[22rem] overflow-auto p-3 font-mono text-xs leading-relaxed"
              tabindex="0"
              role="log"
              aria-relevant="additions"
              aria-label="Pipeline console"
              [attr.aria-live]="ariaLive()"
              (scroll)="onScroll()"
            >
              @if (hiddenEarlier() > 0) {
                <div class="flex justify-center pb-2">
                  <button
                    mat-button
                    type="button"
                    class="!rounded-xl !text-[var(--shell-accent)]"
                    (click)="showEarlier()"
                  >
                    Show earlier events ({{ hiddenEarlier() }})
                  </button>
                </div>
              }
              @for (r of rows(); track r.e.id) {
                <div
                  class="pv-console__row grid grid-cols-[5.5rem_4.75rem_minmax(0,1fr)] gap-3 border-b px-2 py-2 last:border-b-0"
                >
                  <time class="pv-console__muted whitespace-nowrap" [attr.datetime]="r.e.createdAt">{{
                    r.e.createdAt | dateTime: 'time'
                  }}</time>
                  <span class="font-bold uppercase" [class]="r.levelClass">{{ r.e.level }}</span>
                  <span class="min-w-0 whitespace-pre-wrap break-words"
                    ><span class="pv-console__muted">[{{ r.e.stage }}]</span> {{ r.e.message }}</span
                  >
                </div>
              }
            </div>
            @if (unseen() > 0) {
              <button
                type="button"
                class="dd-pill dd-pill--info absolute bottom-3 right-3 cursor-pointer shadow"
                (click)="jumpToLatest()"
              >
                <mat-icon class="!h-4 !w-4 !text-base" aria-hidden="true">arrow_downward</mat-icon>
                {{ jumpLabel() }}
              </button>
            }
          }
        </div>
      </div>
    </details>
  `,
})
export class ConsolePanelComponent {
  readonly events = input.required<readonly ConsoleEventView[]>();
  readonly live = input(false);
  readonly trimmed = input(false);
  readonly defaultOpen = input(true);

  private readonly clipboard = inject(Clipboard);
  private readonly notifications = inject(NotificationService);
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  /** null until the user toggles; then the user's choice wins over `defaultOpen`. */
  private readonly userOpen = signal<boolean | null>(null);
  protected readonly levelFilter = signal<LevelFilter>('all');
  private readonly renderLimit = signal(RENDER_STEP);
  private readonly stickToBottom = signal(true);
  private readonly seenCount = signal(0);

  protected readonly open = computed(() => this.userOpen() ?? this.defaultOpen());
  private readonly filtered = computed(() => {
    const events = this.events();
    return this.levelFilter() === 'issues' ? events.filter((e) => e.level !== 'info') : events;
  });
  protected readonly rows = computed(() =>
    this.filtered()
      .slice(-this.renderLimit())
      .map((e) => ({ e, levelClass: 'pv-console__level--' + e.level })),
  );
  protected readonly hiddenEarlier = computed(() => Math.max(0, this.filtered().length - this.renderLimit()));
  protected readonly unseen = computed(() => Math.max(0, this.rows().length - this.seenCount()));
  protected readonly jumpLabel = computed(() => `Jump to latest (${this.unseen()} new)`);
  protected readonly subtitle = computed(() => {
    const n = this.events().length;
    const base = `${n} event${n === 1 ? '' : 's'}`;
    return this.trimmed() ? `${base} · oldest events trimmed` : base;
  });
  protected readonly ariaLive = computed(() => (this.live() ? 'polite' : 'off'));
  protected readonly levelOptions = computed<SegmentOption<LevelFilter>[]>(() => [
    { value: 'all', label: 'All' },
    { value: 'issues', label: 'Issues', count: this.events().filter((e) => e.level !== 'info').length },
  ]);
  protected readonly emptyTitle = computed(() =>
    this.events().length && this.levelFilter() === 'issues' ? 'No warnings or errors' : 'No console events yet',
  );
  protected readonly emptyMessage = computed(() =>
    this.events().length && this.levelFilter() === 'issues'
      ? 'Switch to All to see every event.'
      : 'Events appear here as the pipeline runs.',
  );

  constructor() {
    // DOM side effect: keep the log pinned to the newest line while the user is at the bottom.
    effect(() => {
      const count = this.rows().length;
      const el = this.scroller()?.nativeElement;
      if (!el || !untracked(this.stickToBottom)) return;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
        this.seenCount.set(count);
      });
    });
  }

  protected onToggle(event: Event): void {
    const isOpen = (event.target as HTMLDetailsElement).open;
    if (isOpen !== this.open()) this.userOpen.set(isOpen);
  }

  protected onScroll(): void {
    const el = this.scroller()?.nativeElement;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX;
    this.stickToBottom.set(atBottom);
    if (atBottom) this.seenCount.set(this.rows().length);
  }

  protected jumpToLatest(): void {
    const el = this.scroller()?.nativeElement;
    this.stickToBottom.set(true);
    this.seenCount.set(this.rows().length);
    if (el) el.scrollTop = el.scrollHeight;
  }

  protected showEarlier(): void {
    this.renderLimit.update((n) => n + RENDER_STEP);
  }

  protected copy(): void {
    const text = this.filtered()
      .map(
        (e) =>
          `${formatDateTime(e.createdAt, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })} ${e.level.toUpperCase()} [${e.stage}] ${e.message}`,
      )
      .join('\n');
    this.clipboard.copy(text);
    this.notifications.success('Console copied');
  }
}
