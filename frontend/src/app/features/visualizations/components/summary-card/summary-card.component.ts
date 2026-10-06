import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { type VisualizationStatus } from '../../../../core/models/domain-enums.model';
import { isTerminalStatus } from '../../../../core/utils/visualization-status.util';
import { EmptyStateComponent } from '../../../../shared/components/empty-state/empty-state.component';
import { MarkdownPipe } from '../../../../shared/pipes/markdown.pipe';

/** AI summary (13 §5.9.7). Markdown goes through the sanitizing markdown pipe only (never trusted as raw HTML). */
@Component({
  selector: 'app-summary-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, EmptyStateComponent, MarkdownPipe],
  host: { class: 'block' },
  template: `
    <mat-card
      class="h-full !rounded-2xl border border-[color:var(--color-border)] bg-[var(--color-bg-secondary)] p-5 shadow-[var(--shadow-md)]"
    >
      <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-lg font-semibold text-[var(--color-text-primary)]">{{ byAi() ? 'AI summary' : 'Summary' }}</h2>
        @if (byAi()) {
          <span class="dd-pill dd-pill--outline" [title]="writtenBy()">AI-generated</span>
        }
      </div>
      @if (markdown()) {
        <div class="pv-prose" [innerHTML]="markdown() | markdown"></div>
        @if (byAi()) {
          <p class="mt-4 text-xs text-[var(--color-text-tertiary)]">{{ footnote() }}</p>
        }
      } @else if (!isTerminal()) {
        <div class="space-y-2" aria-hidden="true">
          <div class="h-3 w-3/4 animate-pulse rounded bg-[var(--color-bg-tertiary)]"></div>
          <div class="h-3 w-full animate-pulse rounded bg-[var(--color-bg-tertiary)]"></div>
          <div class="h-3 w-2/3 animate-pulse rounded bg-[var(--color-bg-tertiary)]"></div>
        </div>
        <p class="mt-3 text-sm text-[var(--color-text-secondary)]">
          The summary is written after rendering and diffing finish.
        </p>
      } @else {
        <app-empty-state title="No summary" [message]="emptyMessage()" />
      }
    </mat-card>
  `,
})
export class SummaryCardComponent {
  readonly markdown = input<string | null>(null);
  readonly status = input.required<VisualizationStatus>();
  readonly aiModel = input<string>('');
  /** False for the fixed no-changes summary, which PRVision writes without AI. */
  readonly byAi = input<boolean>(true);

  protected readonly isTerminal = computed(() => isTerminalStatus(this.status()));
  protected readonly emptyMessage = computed(() =>
    this.status() === 'completed'
      ? 'The AI did not produce a summary for this run.'
      : 'The run stopped before the summary step.',
  );
  protected readonly writtenBy = computed(() => `Written by ${this.aiModel()}`);
  protected readonly footnote = computed(
    () => `Written by AI (${this.aiModel()}), which can make mistakes. Check it against the screenshots.`,
  );
}
