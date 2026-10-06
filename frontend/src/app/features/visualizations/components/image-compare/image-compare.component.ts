import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { type VisualChange } from '../../../../core/models/domain-enums.model';
import { artifactUrl } from '../../../../core/utils/artifact-url.util';
import {
  type SegmentOption,
  SegmentedControlComponent,
} from '../../../../shared/components/segmented-control/segmented-control.component';
import { formatDiffPercent } from '../../../../shared/pipes/diff-percent.pipe';

type CompareMode = 'side' | 'slider' | 'diff';
type ZoomMode = 'fit' | 'actual';
type Side = 'base' | 'head' | 'diff';

interface Placeholder {
  icon: string;
  text: string;
}

/**
 * Base/head/diff viewer (13 §5.9.9): Side by side, keyboard-operable Slider, Diff overlay; 100% (default) or Fit zoom.
 * Image `src` values come only from `artifactUrl()`.
 */
@Component({
  selector: 'app-image-compare',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, MatIconModule, MatSlideToggleModule, SegmentedControlComponent],
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

  protected readonly mode = signal<CompareMode>('side');
  protected readonly zoom = signal<ZoomMode>('actual');
  /** % of the width showing base (left). */
  protected readonly split = signal(50);
  protected readonly diffOpacity = signal(75);
  protected readonly diffOnly = signal(false);
  protected readonly dragging = signal(false);
  private readonly failedLoads = signal<ReadonlySet<Side>>(new Set());

  protected readonly baseSrc = computed(() => (this.failedLoads().has('base') ? null : artifactUrl(this.baseUrl())));
  protected readonly headSrc = computed(() => (this.failedLoads().has('head') ? null : artifactUrl(this.headUrl())));
  protected readonly diffSrc = computed(() => (this.failedLoads().has('diff') ? null : artifactUrl(this.diffUrl())));
  protected readonly canSlide = computed(() => !!this.baseSrc() && !!this.headSrc());
  protected readonly canDiff = computed(() => !!this.diffSrc() && !!this.headSrc());
  protected readonly effectiveMode = computed<CompareMode>(() =>
    (this.mode() === 'slider' && !this.canSlide()) || (this.mode() === 'diff' && !this.canDiff())
      ? 'side'
      : this.mode(),
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
  ]);
  protected readonly zoomOptions: SegmentOption<ZoomMode>[] = [
    { value: 'actual', label: '100%', icon: 'crop_free' },
    { value: 'fit', label: 'Fit', icon: 'fit_screen' },
  ];

  protected readonly baseAlt = computed(() => `Base render of ${this.label()}`);
  protected readonly headAlt = computed(() => `Head render of ${this.label()}`);
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
  protected readonly diffAlt = computed(() => `Pixel differences for ${this.label()}`);
  protected readonly diffLegend = computed(() => {
    const r = this.diffPixelRatio();
    return r === null
      ? 'Highlighted pixels differ between base and head.'
      : `Highlighted pixels differ between base and head (${formatDiffPercent(r)} of the image).`;
  });

  protected markFailed(side: Side): void {
    this.failedLoads.update((s) => new Set(s).add(side));
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

  /** Reads signals, so `sides` tracks them. */
  private placeholderFor(side: 'base' | 'head'): Placeholder {
    const change = this.visualChange();
    const url = side === 'base' ? this.baseUrl() : this.headUrl();
    const error = side === 'base' ? this.baseError() : this.headError();
    if (side === 'base' && change === 'new') return { icon: 'add_box', text: 'Not present on base — new component' };
    if (side === 'head' && change === 'deleted') return { icon: 'delete', text: 'Removed in head — deleted component' };
    if (error) return { icon: 'error', text: 'Render failed — see Render errors below' };
    if (url && this.failedLoads().has(side)) return { icon: 'broken_image', text: 'Image unavailable' };
    return { icon: 'hourglass_empty', text: 'Not rendered' };
  }
}
