import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { type VisualChange } from '../../../../core/models/domain-enums.model';
import { artifactUrl } from '../../../../core/utils/artifact-url.util';
import {
  type SegmentOption,
  SegmentedControlComponent,
} from '../../../../shared/components/segmented-control/segmented-control.component';
import { formatDiffPercent } from '../../../../shared/pipes/diff-percent.pipe';
import { LiveSessionStore } from '../../visualization-detail/live-session.store';
import { LiveCompareComponent } from '../live-compare/live-compare.component';

type CompareMode = 'side' | 'slider' | 'diff' | 'live';
type ZoomMode = 'fit' | 'actual';
type Side = 'base' | 'head' | 'diff';

interface Placeholder {
  icon: string;
  text: string;
}

/** What Live mode opens: the card's component and the state tab currently open (16 §15.6). */
export interface LiveTarget {
  componentId: number;
  stateName: string;
  onBase: boolean;
  onHead: boolean;
}

type LivePanelKind = 'start' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';

interface LivePanelView {
  kind: LivePanelKind;
  message: string | null;
  actionLabel: string | null;
}

/** The Live panel for a session state (16 §15.6). `idleMinutes` comes from the session's `idleTimeoutMs`. */
function livePanel(store: LiveSessionStore): LivePanelView {
  const session = store.session();
  if (store.starting() || session?.status === 'starting') {
    return { kind: 'starting', message: 'Preparing the before and after code…', actionLabel: null };
  }
  if (session === null) {
    return { kind: 'start', message: store.error(), actionLabel: 'Start live mode' };
  }
  switch (session.status) {
    case 'ready':
      return { kind: 'ready', message: null, actionLabel: null };
    case 'stopping':
      return { kind: 'stopping', message: 'Stopping live mode…', actionLabel: null };
    case 'failed':
      return {
        kind: 'failed',
        message: store.error() ?? session.errorMessage ?? 'Live mode stopped with an error.',
        actionLabel: 'Try again',
      };
    default: {
      const minutes = Math.max(1, Math.round(session.idleTimeoutMs / 60_000));
      const message =
        session.stopReason === 'idle'
          ? `Live mode stopped after ${String(minutes)} minutes idle.`
          : 'Live mode stopped.';
      return { kind: 'stopped', message: store.error() ?? message, actionLabel: 'Start again' };
    }
  }
}

/**
 * Base/head/diff viewer (13 §5.9.9): Side by side, keyboard-operable Slider, Diff overlay; 100% (default) or Fit zoom.
 * Image `src` values come only from `artifactUrl()`.
 */
@Component({
  selector: 'app-image-compare',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatSlideToggleModule,
    SegmentedControlComponent,
    LiveCompareComponent,
  ],
  templateUrl: './image-compare.component.html',
  styleUrl: './image-compare.component.scss',
})
export class ImageCompareComponent {
  readonly label = input.required<string>();
  /** Raw `/artifacts/…` paths from the API. */
  readonly baseUrl = input<string | null>(null);
  readonly headUrl = input<string | null>(null);
  readonly diffUrl = input<string | null>(null);
  readonly width = input<number | null>(null);
  readonly height = input<number | null>(null);
  readonly diffPixelRatio = input<number | null>(null);
  readonly visualChange = input<VisualChange | null>(null);
  readonly baseError = input<string | null>(null);
  readonly headError = input<string | null>(null);
  /**
   * 16h state input: the state these images belong to (16 §15.5.2). Set by multi-state cards; adds the state to the
   * image labels and words one-sided states as "Not in the base/head version". null = the component as a whole.
   */
  readonly stateName = input<string | null>(null);
  /** 16j: Live mode can be chosen (the run's `liveAvailable` and the row has a harness). */
  readonly liveEnabled = input(false);
  /** 16j: the component and open state Live mode shows. */
  readonly liveTarget = input<LiveTarget | null>(null);
  /** 16j: the open state's steps in words, for the "do them yourself" banner. */
  readonly stepSummary = input<readonly string[]>([]);

  /** Provided by the visualization detail page; absent elsewhere, which keeps Live off. */
  protected readonly live = inject(LiveSessionStore, { optional: true });

  protected readonly mode = signal<CompareMode>('side');
  protected readonly zoom = signal<ZoomMode>('actual');
  /** % of the width showing base (left). */
  protected readonly split = signal(50);
  protected readonly diffOpacity = signal(75);
  protected readonly diffOnly = signal(false);
  protected readonly dragging = signal(false);
  /** Raw URLs that failed to load; keyed by URL so switching to another state's images starts clean. */
  private readonly failedLoads = signal<ReadonlySet<string>>(new Set());

  protected readonly baseSrc = computed(() => this.loadableSrc(this.baseUrl()));
  protected readonly headSrc = computed(() => this.loadableSrc(this.headUrl()));
  protected readonly diffSrc = computed(() => this.loadableSrc(this.diffUrl()));
  protected readonly canSlide = computed(() => !!this.baseSrc() && !!this.headSrc());
  protected readonly canDiff = computed(() => !!this.diffSrc() && !!this.headSrc());
  protected readonly canLive = computed(() => this.live !== null && this.liveEnabled() && this.liveTarget() !== null);
  protected readonly effectiveMode = computed<CompareMode>(() =>
    (this.mode() === 'slider' && !this.canSlide()) ||
    (this.mode() === 'diff' && !this.canDiff()) ||
    (this.mode() === 'live' && !this.canLive())
      ? 'side'
      : this.mode(),
  );
  protected readonly isLive = computed(() => this.effectiveMode() === 'live');
  protected readonly livePanel = computed<LivePanelView | null>(() =>
    this.live === null || !this.isLive() ? null : livePanel(this.live),
  );
  protected readonly aspectRatio = computed(() => {
    const w = this.width();
    const h = this.height();
    return w && h ? `${w} / ${h}` : null;
  });
  protected readonly modeOptions = computed<SegmentOption<CompareMode>[]>(() => [
    { value: 'side', label: 'Side by side', icon: 'view_column' },
    { value: 'slider', label: 'Slider', icon: 'compare', disabled: !this.canSlide() },
    { value: 'diff', label: 'Diff', icon: 'difference', disabled: !this.canDiff() },
    { value: 'live', label: 'Live', icon: 'sensors', disabled: !this.canLive(), testId: 'mode-live' },
  ]);
  protected readonly zoomOptions: SegmentOption<ZoomMode>[] = [
    { value: 'actual', label: '100%', icon: 'crop_free' },
    { value: 'fit', label: 'Fit', icon: 'fit_screen' },
  ];

  /** "CartSummary" or, for a named state, "CartSummary · Menu open". */
  private readonly subject = computed(() => {
    const state = this.stateName();
    return state && state !== 'Default' ? `${this.label()} · ${state}` : this.label();
  });
  protected readonly baseAlt = computed(() => `Base render of ${this.subject()}`);
  protected readonly headAlt = computed(() => `Head render of ${this.subject()}`);
  protected readonly sides = computed(() => [
    {
      key: 'base' as const,
      caption: 'Base',
      src: this.baseSrc(),
      alt: this.baseAlt(),
      placeholder: this.placeholderFor('base'),
    },
    {
      key: 'head' as const,
      caption: 'Head',
      src: this.headSrc(),
      alt: this.headAlt(),
      placeholder: this.placeholderFor('head'),
    },
  ]);
  protected readonly isActualZoom = computed(() => this.zoom() === 'actual');
  /** Image frame width in px at 100% zoom; null (fill the column) at Fit. */
  protected readonly frameWidth = computed(() => (this.zoom() === 'actual' ? this.width() : null));
  protected readonly zoomRegionLabel = computed(() => `${this.label()} at 100% zoom, scrollable`);
  protected readonly clipPath = computed(() => `inset(0 0 0 ${this.split()}%)`);
  protected readonly sliderLabel = computed(() => `Comparison slider for ${this.label()}`);
  protected readonly sliderValueText = computed(() => `${this.split()}% base, ${100 - this.split()}% head`);
  protected readonly diffImageOpacity = computed(() => (this.diffOnly() ? 1 : this.diffOpacity() / 100));
  protected readonly diffOpacityText = computed(() => `${this.diffOpacity()}%`);
  protected readonly diffAlt = computed(() => `Pixel differences for ${this.subject()}`);
  protected readonly diffLegend = computed(() => {
    const r = this.diffPixelRatio();
    return r === null
      ? 'Highlighted pixels differ between base and head.'
      : `Highlighted pixels differ between base and head (${formatDiffPercent(r)} of the image).`;
  });

  constructor() {
    // Live starts from the open state tab and follows tab switches (D10): ask the session for this component's hosts.
    effect(() => {
      const target = this.liveTarget();
      const ready = this.live?.session()?.status === 'ready';
      if (!this.isLive() || !ready || target === null) return;
      untracked(() => {
        this.live?.ensureOpen(target.componentId, target.stateName, { base: target.onBase, head: target.onHead });
      });
    });
  }

  /** Start live mode / Start again / Try again: one session serves every card of the run. */
  protected startLive(): void {
    this.live?.start();
  }

  protected markFailed(side: Side): void {
    const url = side === 'base' ? this.baseUrl() : side === 'head' ? this.headUrl() : this.diffUrl();
    if (url) this.failedLoads.update((s) => new Set(s).add(url));
  }

  /** Range inputs: read the value in the class (templates may not use $any, 01 template/no-any). */
  protected onSplitInput(event: Event): void {
    this.split.set(Number((event.target as HTMLInputElement).value));
  }

  protected onOpacityInput(event: Event): void {
    this.diffOpacity.set(Number((event.target as HTMLInputElement).value));
  }

  protected onPointerDown(event: PointerEvent): void {
    const stage = event.currentTarget as HTMLElement;
    this.dragging.set(true);
    // Not every environment supports capture for synthetic pointers (tests); dragging still works without it.
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {
      /* no active pointer with this id */
    }
    this.splitFromPointer(event);
  }

  protected onPointerMove(event: PointerEvent): void {
    if (this.dragging()) this.splitFromPointer(event);
  }

  protected stopDragging(): void {
    this.dragging.set(false);
  }

  private splitFromPointer(event: PointerEvent): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = ((event.clientX - rect.left) / rect.width) * 100;
    this.split.set(Math.round(Math.min(100, Math.max(0, pct))));
  }

  private loadableSrc(url: string | null): string | null {
    return url && this.failedLoads().has(url) ? null : artifactUrl(url);
  }

  /** Reads signals, so `sides` tracks them. */
  private placeholderFor(side: 'base' | 'head'): Placeholder {
    const change = this.visualChange();
    const url = side === 'base' ? this.baseUrl() : this.headUrl();
    const error = side === 'base' ? this.baseError() : this.headError();
    const state = this.stateName() !== null;
    if (side === 'base' && change === 'new') {
      return { icon: 'add_box', text: state ? 'Not in the base version' : 'Not present on base — new component' };
    }
    if (side === 'head' && change === 'deleted') {
      return { icon: 'delete', text: state ? 'Not in the head version' : 'Removed in head — deleted component' };
    }
    if (error) return { icon: 'error', text: 'Render failed — see Render errors below' };
    if (url && this.failedLoads().has(url)) return { icon: 'broken_image', text: 'Image unavailable' };
    return { icon: 'hourglass_empty', text: 'Not rendered' };
  }
}
