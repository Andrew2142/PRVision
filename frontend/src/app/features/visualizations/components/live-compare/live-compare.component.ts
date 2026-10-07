import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChildren,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { type LivePageMessage, type LiveSide, type LiveSkippedStep } from '../../../../core/models/live-session.model';
import { InlineAlertComponent } from '../../../../shared/components/inline-alert/inline-alert.component';
import { LiveSessionStore } from '../../visualization-detail/live-session.store';

type LiveSideKind = 'absent' | 'starting' | 'ready' | 'failed' | 'stopped' | 'open_error';

interface LiveSideView {
  side: LiveSide;
  caption: string;
  kind: LiveSideKind;
  url: string | null;
  /** Placeholder or failure text for every kind except `ready`. */
  message: string | null;
  frameTitle: string;
  /** "The base side threw: …" (an error posted by the page after it was ready). */
  thrown: string | null;
}

const MAX_MESSAGE_LENGTH = 500;

function isSkippedStep(v: unknown): v is LiveSkippedStep {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return typeof s['index'] === 'number' && typeof s['action'] === 'string' && typeof s['reason'] === 'string';
}

/**
 * Reads a message a live page posted (16 §7.6.1 step 6). Anything that is not exactly a `prvision-live` state, error or
 * activity message is null. The caller has already checked the sender's origin and window.
 */
export function parseLivePageMessage(data: unknown): LivePageMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m['source'] !== 'prvision-live') return null;
  switch (m['type']) {
    case 'activity':
      return { type: 'activity' };
    case 'error':
      return typeof m['message'] === 'string'
        ? { type: 'error', message: m['message'].slice(0, MAX_MESSAGE_LENGTH) }
        : null;
    case 'state': {
      const skipped = m['skipped'];
      if (typeof m['state'] !== 'string' || !Array.isArray(skipped) || !skipped.every(isSkippedStep)) return null;
      const replayed = typeof m['replayed'] === 'number' ? m['replayed'] : 0;
      return { type: 'state', state: m['state'], replayed, skipped };
    }
    default:
      return null;
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function isLiveSide(v: string | undefined): v is LiveSide {
  return v === 'base' || v === 'head';
}

/**
 * Live mode body (16 §15.6, D10): the before and after components running side by side in two independent iframes
 * served by the run's live hosts on `127.0.0.1`. Each side reloads on its own. Messages from the pages are accepted
 * only from that side's iframe window and origin with `source: "prvision-live"`: skipped steps and errors show as
 * banners, activity keeps the session alive.
 */
@Component({
  selector: 'app-live-compare',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatProgressSpinnerModule, InlineAlertComponent],
  templateUrl: './live-compare.component.html',
  styleUrl: './live-compare.component.scss',
  host: { '(window:message)': 'onMessage($event)' },
})
export class LiveCompareComponent {
  readonly componentId = input.required<number>();
  readonly stateName = input.required<string>();
  /** Component title, for the iframe titles. */
  readonly label = input.required<string>();
  readonly onBase = input(true);
  readonly onHead = input(true);
  /** The state's steps in words (`describeStep`), for the skipped-steps banner. */
  readonly stepSummary = input<readonly string[]>([]);

  private readonly store = inject(LiveSessionStore);
  private readonly frames = viewChildren<ElementRef<HTMLIFrameElement>>('frame');
  /** Bumped by Reload; part of what an iframe was last loaded with. */
  private readonly reloads = signal<Record<LiveSide, number>>({ base: 0, head: 0 });
  private readonly skipped = signal<Record<LiveSide, readonly LiveSkippedStep[]>>({ base: [], head: [] });
  private readonly thrown = signal<Record<LiveSide, string | null>>({ base: null, head: null });
  /** What each iframe element was last pointed at (`<reload>|<url>`); a recreated element starts empty. */
  private readonly loaded = new WeakMap<HTMLIFrameElement, string>();

  protected readonly sides = computed<LiveSideView[]>(() => [this.sideView('base'), this.sideView('head')]);

  /** "Some steps can't be replayed live (hover). Do them yourself: Hover link "Docs"." (16 §15.6). */
  protected readonly skippedText = computed(() => {
    const byIndex = new Map<number, LiveSkippedStep>();
    const all = this.skipped();
    for (const step of [...all.base, ...all.head]) if (!byIndex.has(step.index)) byIndex.set(step.index, step);
    if (!byIndex.size) return null;
    const summary = this.stepSummary();
    const parts = [...byIndex.values()]
      .sort((a, b) => a.index - b.index)
      .map((step) => summary[step.index] ?? step.action);
    return `Some steps can't be replayed live (hover). Do them yourself: ${parts.join(' → ')}.`;
  });

  constructor() {
    // The iframe src is set on the element (never bound): Angular has no safe resource URL for a live host without
    // bypassing its sanitizer, and `urlFor` only builds URLs for `http://127.0.0.1:<port>` hosts.
    effect(() => {
      const views = this.sides();
      const reloads = this.reloads();
      for (const ref of this.frames()) {
        const frame = ref.nativeElement;
        const side = frame.dataset['side'];
        if (!isLiveSide(side)) continue;
        const url = views.find((v) => v.side === side)?.url ?? null;
        if (url === null) continue;
        const marker = `${String(reloads[side])}|${url}`;
        if (this.loaded.get(frame) === marker) continue;
        this.loaded.set(frame, marker);
        this.clearBanners(side);
        frame.src = url;
      }
    });
  }

  /** Reloads only this side's page. */
  protected reload(side: LiveSide): void {
    this.reloads.update((r) => ({ ...r, [side]: r[side] + 1 }));
  }

  /** Try again for a side whose host failed or stopped, or after a failed open. */
  protected retry(): void {
    this.store.reopen(this.componentId(), this.stateName(), { base: this.onBase(), head: this.onHead() });
  }

  protected onMessage(event: MessageEvent): void {
    if (event.source === null) return;
    const ref = this.frames().find((f) => f.nativeElement.contentWindow === event.source);
    const side = ref?.nativeElement.dataset['side'];
    if (!isLiveSide(side)) return;
    const url = this.sides().find((v) => v.side === side)?.url ?? null;
    if (url === null || event.origin !== originOf(url)) return;
    const message = parseLivePageMessage(event.data);
    if (message === null) return;
    switch (message.type) {
      case 'activity':
        this.store.markActivity();
        break;
      case 'error':
        this.thrown.update((t) => ({ ...t, [side]: message.message }));
        break;
      case 'state':
        if (message.state === this.stateName()) this.skipped.update((s) => ({ ...s, [side]: message.skipped }));
        break;
    }
  }

  private clearBanners(side: LiveSide): void {
    this.skipped.update((s) => (s[side].length ? { ...s, [side]: [] } : s));
    this.thrown.update((t) => (t[side] === null ? t : { ...t, [side]: null }));
  }

  /** Reads the store's session signal through `hostFor`/`urlFor`, so `sides` follows every poll. */
  private sideView(side: LiveSide): LiveSideView {
    const caption = side === 'base' ? 'Before' : 'After';
    const state = this.stateName();
    const subject = state === 'Default' ? this.label() : `${this.label()} · ${state}`;
    const base = { side, caption, frameTitle: `${caption}: ${subject} (live)`, thrown: null, url: null };
    const exists = side === 'base' ? this.onBase() : this.onHead();
    if (!exists) {
      return {
        ...base,
        kind: 'absent',
        message: side === 'base' ? 'Not in the base version' : 'Not in the head version',
      };
    }
    const id = this.componentId();
    const openError = this.store.openErrorFor(id, state);
    if (openError !== null) return { ...base, kind: 'open_error', message: openError };
    const host = this.store.hostFor(id, side);
    const url = this.store.urlFor(id, state, side);
    if (host?.status === 'failed') {
      return { ...base, kind: 'failed', message: host.error ?? 'This side could not start.' };
    }
    if (host?.status === 'stopped') {
      return { ...base, kind: 'stopped', message: 'This side stopped to make room for other live components.' };
    }
    if (host?.status === 'ready' && url === null) {
      return { ...base, kind: 'failed', message: 'This side did not report a PRVision live address.' };
    }
    if (url === null) return { ...base, kind: 'starting', message: 'Starting the build server…' };
    const thrown = this.thrown()[side];
    return {
      ...base,
      kind: 'ready',
      url,
      message: null,
      thrown: thrown === null ? null : `The ${side} side threw: ${thrown}`,
    };
  }
}
