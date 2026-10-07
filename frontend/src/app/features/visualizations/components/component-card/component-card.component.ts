import { ClipboardModule } from '@angular/cdk/clipboard';
import { ChangeDetectionStrategy, Component, computed, input, linkedSignal, output, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { type RepositoryFramework } from '../../../../core/models/domain-enums.model';
import { type ComponentStateView, type VisualizationComponentView } from '../../../../core/models/visualization.model';
import { EmptyStateComponent } from '../../../../shared/components/empty-state/empty-state.component';
import { InlineAlertComponent } from '../../../../shared/components/inline-alert/inline-alert.component';
import { StatusPillComponent } from '../../../../shared/components/status-pill/status-pill.component';
import { formatDiffPercent } from '../../../../shared/pipes/diff-percent.pipe';
import { CodeDiffComponent } from '../code-diff/code-diff.component';
import { countDiffStats } from '../code-diff/unified-diff';
import { ImageCompareComponent } from '../image-compare/image-compare.component';
import { StateTabsComponent, isChangedState } from '../state-tabs/state-tabs.component';
import { StructuralDiffListComponent } from '../structural-diff-list/structural-diff-list.component';
import {
  harnessOriginLabel,
  renderErrorBlock,
  statesChangedLabel,
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

/** One Default state built from the row (rows without state rows; the API normally synthesizes it, 16 §7.9). */
export function rowAsDefaultState(c: VisualizationComponentView): ComponentStateView {
  return {
    ordinal: 0,
    name: 'Default',
    onBase: c.changeKind !== 'added',
    onHead: c.changeKind !== 'removed',
    steps: [],
    stepSummary: [],
    renderStatus: c.renderStatus,
    visualChange: c.visualChange,
    baseImageUrl: c.baseImageUrl,
    headImageUrl: c.headImageUrl,
    diffImageUrl: c.diffImageUrl,
    imageWidth: c.imageWidth,
    imageHeight: c.imageHeight,
    diffPixelRatio: c.diffPixelRatio,
    baseError: c.baseError,
    headError: c.headError,
  };
}

/** Which side the saved harness no longer renders: the side(s) with an error in any state. */
export function failingSideText(c: VisualizationComponentView, states: readonly ComponentStateView[]): string {
  const base = !!c.baseError || states.some((s) => !!s.baseError);
  const head = !!c.headError || states.some((s) => !!s.headError);
  if (base && head) return 'base and head sides';
  return base ? 'base side' : 'head side';
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
    StateTabsComponent,
    InlineAlertComponent,
    MatProgressSpinnerModule,
  ],
  templateUrl: './component-card.component.html',
  host: { class: 'block' },
})
export class ComponentCardComponent {
  readonly component = input.required<VisualizationComponentView>();
  readonly runActive = input(false);
  /** Framework of the visualization's repository: Angular wording for structure and errors (15 §5.9.1). */
  readonly framework = input<RepositoryFramework>('react_vite');
  /** A Repair request for this card is in flight (16 §15.5.3). */
  readonly repairRequested = input(false);
  /** Repair clicked: the page starts the repair job. */
  readonly repair = output<number>();

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
  /** "2 of 3 states changed" for multi-state rows, else "Changed · 4.2%". */
  protected readonly visualLabel = computed(() => {
    const c = this.component();
    const states = statesChangedLabel(c.stateCount, c.changedStateCount);
    if (states) return states;
    return c.visualChange === 'changed' && c.diffPixelRatio !== null
      ? `Changed · ${formatDiffPercent(c.diffPixelRatio)}`
      : null;
  });

  // States (16 §15.5.2)
  protected readonly states = computed<readonly ComponentStateView[]>(() => {
    const c = this.component();
    return c.states.length ? c.states : [rowAsDefaultState(c)];
  });
  private readonly firstChangedOrdinal = computed(() => this.states().find(isChangedState)?.ordinal ?? 0);
  /** Opens on the first changed state; the user's pick stays until the first changed state moves. */
  protected readonly selectedState = linkedSignal(() => this.firstChangedOrdinal());
  protected readonly state = computed(() => {
    const list = this.states();
    const fallback = list[0] ?? rowAsDefaultState(this.component());
    return list.find((s) => s.ordinal === this.selectedState()) ?? fallback;
  });
  protected readonly multiState = computed(() => this.states().length > 1);
  protected readonly stateTabsId = computed(() => `cmp-${this.component().id}-states`);
  protected readonly stepsText = computed(() => {
    const summary = this.state().stepSummary;
    return summary.length ? `Reached by: ${summary.join(' → ')}` : null;
  });

  // Harness status (16 §15.5.3)
  protected readonly harnessLabel = computed(() => harnessOriginLabel(this.component().harness.origin));
  protected readonly sourceChanged = computed(() => this.component().harness.sourceChangedSinceWrite === true);
  protected readonly needsUpdate = computed(() => this.component().harness.needsUpdate);
  protected readonly needsUpdateText = computed(
    () =>
      `The saved harness no longer renders this component on the ${failingSideText(this.component(), this.states())}. ` +
      'Repair asks the AI for a new harness and saves it to the library.',
  );
  protected readonly repairing = computed(() => this.component().harness.repairing || this.repairRequested());
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

  protected requestRepair(): void {
    if (!this.repairing()) this.repair.emit(this.component().id);
  }

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
