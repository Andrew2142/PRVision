import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, InjectionToken, NgZone, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { type VisualizationStatus } from '../models/domain-enums.model';
import { type VisualizationDetailView } from '../models/visualization.model';
import { isTerminalStatus } from '../utils/visualization-status.util';

/** The browser Notification API, or null where it does not exist. A token so tests can swap it. */
export type NotificationApi = Pick<typeof Notification, 'permission' | 'requestPermission'> &
  (new (title: string, options?: NotificationOptions) => Pick<Notification, 'close' | 'onclick'>);

export const NOTIFICATION_API = new InjectionToken<NotificationApi | null>('NOTIFICATION_API', {
  providedIn: 'root',
  factory: () => (typeof Notification === 'undefined' ? null : Notification),
});

/** Statuses that need the user: a result to read, a failure, or the component-limit choice. Cancelled does not. */
type AlertStatus = Extract<VisualizationStatus, 'completed' | 'failed' | 'awaiting_confirmation'>;

interface AlertCopy {
  tabMark: string;
  title: string;
  body: string;
}

const ICON = '/favicon.svg';

function alertCopy(status: AlertStatus, detail: VisualizationDetailView): AlertCopy {
  switch (status) {
    case 'completed':
      return {
        tabMark: '✓',
        title: 'Visualization ready',
        body: `${detail.title}: ${detail.changedCount} of ${detail.componentCount} components changed.`,
      };
    case 'failed':
      return { tabMark: '!', title: 'Visualization failed', body: `${detail.title}: open it to see what went wrong.` };
    case 'awaiting_confirmation':
      return {
        tabMark: '?',
        title: 'Visualization needs your choice',
        body: `${detail.title}: choose how many components to render.`,
      };
  }
}

function isAlertStatus(status: VisualizationStatus): status is AlertStatus {
  return status === 'completed' || status === 'failed' || status === 'awaiting_confirmation';
}

/**
 * Calls the user back to a run that finished while its tab was in the background: a desktop notification that
 * focuses the tab and opens the run when clicked, plus a mark on the tab title until the tab is visible again.
 */
@Injectable({ providedIn: 'root' })
export class RunAlertService {
  private readonly document = inject(DOCUMENT);
  private readonly api = inject(NOTIFICATION_API);
  private readonly title = inject(Title);
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);
  private markedTitle: { marked: string; original: string } | null = null;

  constructor() {
    const onVisible = (): void => {
      if (this.document.visibilityState === 'visible') this.clearTabMark();
    };
    this.document.addEventListener('visibilitychange', onVisible);
    inject(DestroyRef).onDestroy(() => {
      this.document.removeEventListener('visibilitychange', onVisible);
    });
  }

  /** Asks once, from a click, so the browser shows the prompt. Never throws. */
  requestPermission(): void {
    if (this.api?.permission !== 'default') return;
    try {
      void this.api.requestPermission().catch(() => undefined);
    } catch {
      // Older browsers take a callback and throw on the promise form; the tab mark still works.
    }
  }

  /** Call on every poll with the previous status; alerts once, on the move into a status that needs the user. */
  statusChanged(previous: VisualizationStatus | null, detail: VisualizationDetailView): void {
    const next = detail.status;
    if (previous === null || previous === next || !isAlertStatus(next)) return;
    if (isTerminalStatus(previous)) return;
    if (this.document.visibilityState === 'visible') return;

    const copy = alertCopy(next, detail);
    this.markTab(copy.tabMark);
    this.notify(copy, detail.id);
  }

  private notify(copy: AlertCopy, id: number): void {
    if (this.api?.permission !== 'granted') return;
    try {
      const n = new this.api(copy.title, { body: copy.body, icon: ICON, tag: `prvision-visualization-${id}` });
      n.onclick = () => {
        this.zone.run(() => {
          this.document.defaultView?.focus();
          void this.router.navigate(['/visualizations', id]);
        });
        n.close();
      };
    } catch {
      // Notification construction can throw (e.g. Android Chrome needs a service worker); the tab mark remains.
    }
  }

  private markTab(mark: string): void {
    const current = this.title.getTitle();
    const original = this.markedTitle?.marked === current ? this.markedTitle.original : current;
    const marked = `(${mark}) ${original}`;
    this.markedTitle = { marked, original };
    this.title.setTitle(marked);
  }

  private clearTabMark(): void {
    if (!this.markedTitle) return;
    // Only undo our own change; if the page retitled itself meanwhile, keep its title.
    if (this.title.getTitle() === this.markedTitle.marked) this.title.setTitle(this.markedTitle.original);
    this.markedTitle = null;
  }
}
