import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { type VisualChange } from '../../../../core/models/domain-enums.model';
import { artifactUrl } from '../../../../core/utils/artifact-url.util';
import { LiveSessionStore } from '../../visualization-detail/live-session.store';
import { LiveCompareComponent } from '../live-compare/live-compare.component';
import { type ContentCrop, measureContentCrop } from './content-crop';

type Side = 'base' | 'head';

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
 * Before/after viewer: the two screenshots side by side, cropped to the part that holds the component (one crop for
 * both, so they line up), or the live components while the card is playing (16 §15.6). Image `src` values come only
 * from `artifactUrl()`.
 */
@Component({
  selector: 'app-image-compare',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatProgressSpinnerModule, LiveCompareComponent],
  templateUrl: './image-compare.component.html',
  styleUrl: './image-compare.component.scss',
})
export class ImageCompareComponent {
  readonly label = input.required<string>();
  /** Raw `/artifacts/…` paths from the API. */
  readonly baseUrl = input<string | null>(null);
  readonly headUrl = input<string | null>(null);
  readonly width = input<number | null>(null);
  readonly height = input<number | null>(null);
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
  /** The card's Play button: show the live components instead of the screenshots. */
  readonly live = input(false);

  /** Provided by the visualization detail page; absent elsewhere, which keeps Live off. */
  protected readonly liveStore = inject(LiveSessionStore, { optional: true });

  /** Raw URLs that failed to load; keyed by URL so switching to another state's images starts clean. */
  private readonly failedLoads = signal<ReadonlySet<string>>(new Set());
  /** Measured crop for the current pair of screenshots; null shows them whole. */
  protected readonly crop = signal<ContentCrop | null>(null);

  protected readonly baseSrc = computed(() => this.loadableSrc(this.baseUrl()));
  protected readonly headSrc = computed(() => this.loadableSrc(this.headUrl()));
  protected readonly canLive = computed(
    () => this.liveStore !== null && this.liveEnabled() && this.liveTarget() !== null,
  );
  protected readonly isLive = computed(() => this.live() && this.canLive());
  protected readonly livePanel = computed<LivePanelView | null>(() =>
    this.liveStore === null || !this.isLive() ? null : livePanel(this.liveStore),
  );
  protected readonly aspectRatio = computed(() => {
    const w = this.width();
    const h = this.height();
    return w && h ? `${w} / ${h}` : null;
  });

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
      caption: 'Before',
      src: this.baseSrc(),
      alt: this.baseAlt(),
      placeholder: this.placeholderFor('base'),
    },
    {
      key: 'head' as const,
      caption: 'After',
      src: this.headSrc(),
      alt: this.headAlt(),
      placeholder: this.placeholderFor('head'),
    },
  ]);
  /** Where the full screenshot sits inside the crop box, in % of the box. */
  protected readonly cropStyle = computed(() => {
    const c = this.crop();
    if (!c) return null;
    return {
      ratio: `${String(c.width)} / ${String(c.height)}`,
      maxWidth: c.width,
      imgWidth: (c.imageWidth / c.width) * 100,
      left: (-c.x / c.width) * 100,
      top: (-c.y / c.height) * 100,
      background: c.background,
    };
  });

  /** Guards against an older measurement landing after the images changed. */
  private cropToken = 0;

  constructor() {
    // Measure one crop for both screenshots whenever the pair changes.
    effect(() => {
      const srcs = [this.baseSrc(), this.headSrc()].filter((s): s is string => s !== null);
      const token = ++this.cropToken;
      untracked(() => {
        this.crop.set(null);
      });
      if (!srcs.length) return;
      void measureContentCrop(srcs).then((crop) => {
        if (token === this.cropToken) this.crop.set(crop);
      });
    });
    // Play starts the run's live session when there is none yet; after an error or a stop the panel asks first.
    effect(() => {
      const store = this.liveStore;
      if (!store || !this.isLive()) return;
      if (store.session() === null && !store.starting() && store.error() === null) {
        untracked(() => {
          store.start();
        });
      }
    });
    // Live follows the open state tab (D10): ask the session for this component's hosts.
    effect(() => {
      const target = this.liveTarget();
      const ready = this.liveStore?.session()?.status === 'ready';
      if (!this.isLive() || !ready || target === null) return;
      untracked(() => {
        this.liveStore?.ensureOpen(target.componentId, target.stateName, { base: target.onBase, head: target.onHead });
      });
    });
  }

  /** Start again / Try again: one session serves every card of the run. */
  protected startLive(): void {
    this.liveStore?.start();
  }

  protected markFailed(side: Side): void {
    const url = side === 'base' ? this.baseUrl() : this.headUrl();
    if (url) this.failedLoads.update((s) => new Set(s).add(url));
  }

  private loadableSrc(url: string | null): string | null {
    return url && this.failedLoads().has(url) ? null : artifactUrl(url);
  }

  /** Reads signals, so `sides` tracks them. */
  private placeholderFor(side: Side): Placeholder {
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
