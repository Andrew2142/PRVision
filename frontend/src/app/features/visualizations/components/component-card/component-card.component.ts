import { ClipboardModule } from '@angular/cdk/clipboard';
import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { type RepositoryFramework } from '../../../../core/models/domain-enums.model';
import { type VisualizationComponentView } from '../../../../core/models/visualization.model';
import { EmptyStateComponent } from '../../../../shared/components/empty-state/empty-state.component';
import { StatusPillComponent } from '../../../../shared/components/status-pill/status-pill.component';
import { formatDiffPercent } from '../../../../shared/pipes/diff-percent.pipe';
import { CodeDiffComponent } from '../code-diff/code-diff.component';
import { countDiffStats } from '../code-diff/unified-diff';
import { ImageCompareComponent } from '../image-compare/image-compare.component';
import { StructuralDiffListComponent } from '../structural-diff-list/structural-diff-list.component';
import {
  renderErrorBlock,
  structuralSectionTitle,
  successorEvidenceLines,
  type RenderErrorBlock,
} from '../../visualization-format';

type CardSection = 'code' | 'structure' | 'errors';

/** The card's "What changed" block: the AI note in plain language, with the change reason as context. */
export interface WhatChangedView {
  main: string;
  reason: string | null;
  /** True when `main` is the AI note (shows the "AI" disclaimer pill). */
  fromAi: boolean;
}

/** One file path line of the card header; a replaced component shows the old (before) and the new (after) path. */
export interface CardPath {
  label: string | null;
  path: string;
}

/**
 * One component result (13 §5.9.8; revision 5): pills, a "What changed" block (AI note, change reason), image viewer
 * and expandable code/structure panels. A replaced component (00 §17) is titled "OldName → NewName", lists both
 * paths and the plain evidence for the pairing.
 */
@Component({
  selector: 'app-component-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ClipboardModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    EmptyStateComponent,
    StatusPillComponent,
    ImageCompareComponent,
    CodeDiffComponent,
    StructuralDiffListComponent,
  ],
  templateUrl: './component-card.component.html',
  host: { class: 'block' },
})
export class ComponentCardComponent {
  readonly component = input.required<VisualizationComponentView>();
  readonly runActive = input(false);
  /** Framework of the visualization's repository: Angular wording for structure and errors (15 §5.9.1). */
  readonly framework = input<RepositoryFramework>('react_vite');

  /** Sections render their content only while open; Render errors starts open. */
  private readonly openSections = signal<ReadonlySet<CardSection>>(new Set<CardSection>(['errors']));
  protected readonly codeOpen = computed(() => this.openSections().has('code'));
  protected readonly structureOpen = computed(() => this.openSections().has('structure'));

  protected readonly headingId = computed(() => `cmp-${this.component().id}`);
  /** True for a replaced row that names the removed component (00 §17). */
  protected readonly isReplaced = computed(() => {
    const c = this.component();
    return c.changeKind === 'replaced' && !!c.baseDisplayName && !!c.baseFilePath;
  });
  protected readonly title = computed(() => {
    const c = this.component();
    return this.isReplaced() ? `${c.baseDisplayName} → ${c.displayName}` : c.displayName;
  });
  protected readonly paths = computed<CardPath[]>(() => {
    const c = this.component();
    return this.isReplaced() && c.baseFilePath
      ? [
          { label: 'Before', path: c.baseFilePath },
          { label: 'After', path: c.filePath },
        ]
      : [{ label: null, path: c.filePath }];
  });
  /** Plain-language reasons the two components were paired. */
  protected readonly evidenceLines = computed(() =>
    this.isReplaced() ? successorEvidenceLines(this.component().successorEvidence) : [],
  );
  protected readonly rankLabel = computed(() => `#${this.component().rank + 1}`);
  protected readonly exportLabel = computed(() => {
    const c = this.component();
    return c.exportName !== 'default' && c.exportName !== c.displayName ? `export ${c.exportName}` : null;
  });
  protected readonly visualLabel = computed(() => {
    const c = this.component();
    return c.visualChange === 'changed' && c.diffPixelRatio !== null
      ? `Changed · ${formatDiffPercent(c.diffPixelRatio)}`
      : null;
  });
  protected readonly showRenderPill = computed(() => this.component().renderStatus !== 'rendered');
  protected readonly diffStats = computed(() => {
    const diff = this.component().codeDiff;
    return diff === null ? null : countDiffStats(diff);
  });
  protected readonly diffStatsLabel = computed(() => {
    const s = this.diffStats();
    return s ? `+${s.added} −${s.removed}` : '';
  });
  protected readonly structuralTitle = computed(() => structuralSectionTitle(this.framework()));
  protected readonly structuralCount = computed(() => this.component().structuralDiff?.length ?? 0);
  protected readonly structuralLabel = computed(() => {
    const n = this.structuralCount();
    return `${n} change${n === 1 ? '' : 's'}`;
  });
  protected readonly hasErrors = computed(() => !!this.component().baseError || !!this.component().headError);
  protected readonly errorBlocks = computed<RenderErrorBlock[]>(() => {
    const c = this.component();
    const framework = this.framework();
    const blocks: RenderErrorBlock[] = [];
    if (c.baseError) blocks.push(renderErrorBlock('Base', c.baseError, framework));
    if (c.headError) blocks.push(renderErrorBlock('Head', c.headError, framework));
    return blocks;
  });
  protected readonly errorsLabel = computed(() => {
    const blocks = this.errorBlocks();
    return blocks.length === 2 ? 'Base and head failed' : `${blocks[0]?.side ?? 'Render'} failed`;
  });
  protected readonly pendingText = computed(() => (this.runActive() ? 'Waiting to render…' : 'Not rendered'));
  protected readonly skipMessage = computed(
    () =>
      this.component().skipReason ??
      'This component was not rendered (render cap reached or not renderable in isolation).',
  );
  /** AI note as the main text and the change reason underneath; the reason alone when there is no note. */
  protected readonly whatChanged = computed<WhatChangedView | null>(() => {
    const { aiNote, changeReason } = this.component();
    const note = aiNote?.trim() ? aiNote : null;
    const reason = changeReason?.trim() ? changeReason : null;
    if (note) return { main: note, reason, fromAi: true };
    return reason ? { main: reason, reason: null, fromAi: false } : null;
  });
  /** Unchanged components hide their (identical) screenshots until asked; the code diff stays visible. */
  protected readonly isUnchanged = computed(() => this.component().visualChange === 'unchanged');
  protected readonly showUnchangedShots = signal(false);
  protected readonly showParentNote = computed(() => {
    const c = this.component();
    return c.changeKind === 'affected_parent' && !c.codeDiff && !c.changeReason;
  });

  protected onToggle(section: CardSection, event: Event): void {
    const isOpen = (event.target as HTMLDetailsElement).open;
    this.openSections.update((set) => {
      if (set.has(section) === isOpen) return set;
      const next = new Set(set);
      if (isOpen) next.add(section);
      else next.delete(section);
      return next;
    });
  }
}
