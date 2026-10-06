import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { type RepositoryFramework } from '../../../../core/models/domain-enums.model';
import { type StructuralChange } from '../../../../core/models/visualization.model';
import { structuralIntro } from '../../visualization-format';

const INITIAL_LIMIT = 200;
const MAX_SHOWN_CHARS = 300;

export interface TruncatedText {
  /** First 300 chars + "…" when longer. */
  shown: string;
  full: string;
}

export interface StructuralRow {
  key: number;
  pillClass: string;
  kindLabel: string;
  target: string;
  path: string;
  before: TruncatedText | null;
  after: TruncatedText | null;
  /** className changes (00 §14.4 tokensAdded/tokensRemoved): shown as token chips instead of before/after. */
  tokensAdded: string[];
  tokensRemoved: string[];
}

function truncate(text: string): TruncatedText {
  return { shown: text.length > MAX_SHOWN_CHARS ? `${text.slice(0, MAX_SHOWN_CHARS)}…` : text, full: text };
}

export function toStructuralRow(c: StructuralChange, key: number): StructuralRow {
  const base = { key, path: c.path, before: null, after: null, tokensAdded: [], tokensRemoved: [] };
  switch (c.kind) {
    case 'element_added':
      return { ...base, pillClass: 'dd-pill dd-pill--success', kindLabel: 'Added', target: `<${c.tag}>` };
    case 'element_removed':
      return { ...base, pillClass: 'dd-pill dd-pill--danger', kindLabel: 'Removed', target: `<${c.tag}>` };
    case 'attribute_changed': {
      const tokens = c.tokensAdded !== undefined || c.tokensRemoved !== undefined;
      return {
        ...base,
        pillClass: 'dd-pill dd-pill--info',
        kindLabel: 'Attribute',
        target: `<${c.tag}> ${c.attribute}`,
        before: tokens ? null : truncate(c.before ?? '∅'),
        after: tokens ? null : truncate(c.after ?? '∅'),
        tokensAdded: c.tokensAdded ?? [],
        tokensRemoved: c.tokensRemoved ?? [],
      };
    }
    case 'text_changed':
      return {
        ...base,
        pillClass: 'dd-pill dd-pill--accent',
        kindLabel: 'Text',
        target: 'text',
        before: truncate(c.before),
        after: truncate(c.after),
      };
  }
}

/** DOM differences between the base and head renders (13 §5.9.11). Every value is interpolated text. */
@Component({
  selector: 'app-structural-diff-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule],
  host: { class: 'block' },
  template: `
    <p class="mb-3 text-sm text-[var(--color-text-secondary)]">{{ intro() }}</p>
    <ul class="divide-y divide-[color:var(--color-border)] rounded-xl border border-[color:var(--color-border)]">
      @for (r of rows(); track r.key) {
        <li class="flex flex-col gap-2 px-4 py-3">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <span [class]="r.pillClass">{{ r.kindLabel }}</span>
            <span class="pv-code text-[var(--color-text-primary)]">{{ r.target }}</span>
            <span class="pv-code min-w-0 truncate text-[var(--color-text-tertiary)]" [title]="r.path">{{
              r.path
            }}</span>
          </div>
          @if (r.tokensAdded.length || r.tokensRemoved.length) {
            <div class="flex flex-wrap gap-1">
              @for (t of r.tokensRemoved; track t) {
                <span class="dd-pill dd-pill--danger pv-code">− {{ t }}</span>
              }
              @for (t of r.tokensAdded; track t) {
                <span class="dd-pill dd-pill--success pv-code">+ {{ t }}</span>
              }
            </div>
          } @else {
            @if (r.before; as before) {
              <p class="pv-code whitespace-pre-wrap break-words text-[var(--color-error)]" [title]="before.full">
                − {{ before.shown }}
              </p>
            }
            @if (r.after; as after) {
              <p class="pv-code whitespace-pre-wrap break-words text-[var(--color-success)]" [title]="after.full">
                + {{ after.shown }}
              </p>
            }
          }
        </li>
      }
    </ul>
    @if (hiddenCount() > 0) {
      <button mat-button type="button" class="mt-2 !rounded-xl" (click)="showAll()">{{ showAllLabel() }}</button>
    }
  `,
})
export class StructuralDiffListComponent {
  readonly changes = input.required<readonly StructuralChange[]>();
  /** Angular changes come from templates (15e), React ones from JSX (11). */
  readonly framework = input<RepositoryFramework>('react_vite');
  protected readonly intro = computed(() => structuralIntro(this.framework()));

  private readonly limit = signal(INITIAL_LIMIT);
  protected readonly rows = computed(() => this.changes().slice(0, this.limit()).map(toStructuralRow));
  protected readonly hiddenCount = computed(() => Math.max(0, this.changes().length - this.limit()));
  protected readonly showAllLabel = computed(() => `Show all ${this.changes().length}`);

  protected showAll(): void {
    this.limit.set(this.changes().length);
  }
}
