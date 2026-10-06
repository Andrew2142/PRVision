import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { type DiffLineKind, parseUnifiedDiff } from './unified-diff';

const MARKER: Record<DiffLineKind, string> = { add: '+', del: '-', context: ' ', meta: '', hunk: '', note: '' };
const INITIAL_LIMIT = 2000;

/** Coloured unified diff with old/new line numbers (13 §5.9.10). Content is interpolated text, never innerHTML. */
@Component({
  selector: 'app-code-diff',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule],
  host: { class: 'block' },
  template: `
    <pre
      class="pv-code pv-code-block"
      tabindex="0"
      role="region"
      aria-label="Unified code diff"
    ><code class="pv-code">@for (r of rows(); track r.key) {<span [class]="r.cls"><span class="pv-diff-line__num">{{ r.oldNo }}</span><span class="pv-diff-line__num">{{ r.newNo }}</span><span>{{ r.marker }}{{ r.text }}</span></span>}</code></pre>
    @if (hiddenCount() > 0) {
      <button mat-button type="button" class="mt-2 !rounded-xl" (click)="showAll()">{{ showAllLabel() }}</button>
    }
  `,
})
export class CodeDiffComponent {
  readonly diff = input.required<string>();

  protected readonly lines = computed(() => parseUnifiedDiff(this.diff()));
  private readonly limit = signal(INITIAL_LIMIT);
  protected readonly rows = computed(() =>
    this.lines()
      .slice(0, this.limit())
      .map((l) => ({ ...l, cls: 'pv-diff-line pv-diff-line--' + l.kind, marker: MARKER[l.kind] })),
  );
  protected readonly hiddenCount = computed(() => Math.max(0, this.lines().length - this.limit()));
  protected readonly showAllLabel = computed(() => `Show all ${this.lines().length} lines`);

  protected showAll(): void {
    this.limit.set(this.lines().length);
  }
}
