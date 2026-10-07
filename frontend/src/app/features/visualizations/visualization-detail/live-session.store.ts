import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { type Observable, Subscription, timer } from 'rxjs';
import { LIVE_POLL_FAST_MS, LIVE_POLL_SLOW_MS } from '../../../core/constants/polling.constants';
import { type ApiError, toApiError } from '../../../core/models/api-error.model';
import { type LiveSessionStatus } from '../../../core/models/domain-enums.model';
import { type LiveHostView, type LiveSessionView, type LiveSide } from '../../../core/models/live-session.model';
import { ApiService } from '../../../core/services/api.service';
import { userMessageFor } from '../../../core/utils/error-messages.util';

/** Attribute every live iframe carries, so focus moving into one counts as activity (16 §15.6). */
export const LIVE_FRAME_ATTRIBUTE = 'data-prvision-live-frame';

/** Live hosts bind 127.0.0.1 on an ephemeral port (16 §12.4, 00 §21.12); any other origin is never framed. */
const LIVE_HOST_ORIGIN = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/;
/** `/.prvision-harness/index.html` (React) or `/index.html` (Angular): an absolute path, no `..`, query or hash. */
const LIVE_HARNESS_PATH = /^\/(?!\/)[\w.\-/]*$/;
/** Heartbeats run while the session can still serve pages; polling also follows `stopping` to its end. */
const HEARTBEAT_STATUSES: readonly LiveSessionStatus[] = ['starting', 'ready'];
const POLLED_STATUSES: readonly LiveSessionStatus[] = ['starting', 'ready', 'stopping'];
/** Used until the first session arrives with its own interval (LIVE_HEARTBEAT_INTERVAL_MS). */
const DEFAULT_HEARTBEAT_MS = 30_000;
const SIDES: readonly LiveSide[] = ['base', 'head'];
/** Statuses only move forward; an answer that would move a session back (a poll sent before Stop) is ignored. */
const STATUS_RANK: Record<LiveSessionStatus, number> = { starting: 0, ready: 1, stopping: 2, stopped: 3, failed: 3 };
/** Host preference when a side lists the component more than once (an LRU-stopped entry next to a restarted one). */
const HOST_RANK: Record<LiveHostView['status'], number> = { ready: 0, starting: 1, failed: 2, stopped: 3 };

/** Which sides the opened state exists on; a side that does not exist never gets a host. */
export interface LiveSides {
  base: boolean;
  head: boolean;
}

interface OpenRecord {
  componentId: number;
  stateName: string;
  sides: LiveSides;
  inFlight: boolean;
  error: string | null;
}

const BOTH_SIDES: LiveSides = { base: true, head: true };

function openKey(componentId: number, stateName: string): string {
  return `${String(componentId)}\u0000${stateName}`;
}

/**
 * The page URL for one side (16 §14.6): `${origin}${harnessUrlPath}?c=…&s=…&live=1&parent=…`. Returns null unless the
 * host origin is `http://127.0.0.1:<port>` and the path is a plain absolute path, so the iframe can only ever load a
 * PRVision live host.
 */
export function liveSideUrl(
  host: Pick<LiveHostView, 'origin' | 'harnessUrlPath'>,
  componentId: number,
  stateName: string,
  parentOrigin: string,
): string | null {
  const { origin, harnessUrlPath } = host;
  if (origin === null || harnessUrlPath === null) return null;
  const port = LIVE_HOST_ORIGIN.exec(origin)?.[1];
  if (port === undefined || Number(port) < 1 || Number(port) > 65_535) return null;
  if (!LIVE_HARNESS_PATH.test(harnessUrlPath) || /(^|\/)\.\.(\/|$)/.test(harnessUrlPath)) return null;
  const query =
    `c=${String(componentId)}&s=${encodeURIComponent(stateName)}` +
    `&live=1&parent=${encodeURIComponent(parentOrigin)}`;
  return `${origin}${harnessUrlPath}?${query}`;
}

/**
 * Live mode for one run (16 §15.6, D10), provided by the visualization detail page. One Live click starts the
 * session for the whole run; each card then asks for its component's hosts (`ensureOpen`). Polls the session every
 * 1 s while it or a requested host is starting and every 10 s otherwise; sends a heartbeat every
 * `heartbeatIntervalMs` saying whether the reviewer used the page (hidden tabs never count); stops the session when
 * the page goes away (destroy) or unloads (beacon on `pagehide`).
 */
@Injectable()
export class LiveSessionStore {
  private readonly api = inject(ApiService);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  readonly session = signal<LiveSessionView | null>(null);
  /** The Start request is in flight. */
  readonly starting = signal(false);
  /** Why the last Start failed (for example the two-session limit); cleared by the next Start. */
  readonly error = signal<string | null>(null);

  private visualizationId: number | null = null;
  /** Bumped whenever the run changes or the session is stopped: late responses of an older generation are dropped. */
  private generation = 0;
  private readonly opens = signal<ReadonlyMap<string, OpenRecord>>(new Map());
  /** Activity seen since the last heartbeat (16 §15.6). */
  private activity = false;
  private destroyed = false;
  private pollTimer: Subscription | null = null;
  private pollRequest: Subscription | null = null;
  private heartbeat: { sessionId: number; intervalMs: number; sub: Subscription } | null = null;
  /** Start, open and heartbeat requests; cancelled when the run changes or the page goes away. */
  private readonly requests = new Set<Subscription>();

  /** The session can serve pages: heartbeats run and leaving the run stops it. */
  readonly active = computed(() => {
    const s = this.session();
    return s !== null && HEARTBEAT_STATUSES.includes(s.status);
  });
  /** A requested component still waits for its hosts (no host listed yet, or one is starting). */
  private readonly pendingOpen = computed(() => {
    if (this.session()?.status !== 'ready') return false;
    for (const r of this.opens().values()) {
      if (r.inFlight) return true;
      if (r.error !== null) continue;
      for (const side of SIDES) {
        if (!r.sides[side]) continue;
        const host = this.hostFor(r.componentId, side);
        if (host === null || host.status === 'starting') return true;
      }
    }
    return false;
  });

  constructor() {
    const onInput = (): void => {
      this.markActivity();
    };
    const onBlur = (): void => {
      // Focus moved into a cross-origin live iframe: the page's own listeners never see that input.
      if (this.document.activeElement?.hasAttribute(LIVE_FRAME_ATTRIBUTE)) this.markActivity();
    };
    const onPageHide = (): void => {
      this.leaveWithBeacon();
    };
    const inputEvents = ['keydown', 'pointerdown', 'click', 'scroll', 'wheel'] as const;
    for (const type of inputEvents) this.document.addEventListener(type, onInput, { capture: true, passive: true });
    const win = this.document.defaultView;
    win?.addEventListener('blur', onBlur);
    win?.addEventListener('pagehide', onPageHide);
    this.destroyRef.onDestroy(() => {
      this.stop('left');
      this.destroyed = true;
      this.teardown();
      for (const type of inputEvents) this.document.removeEventListener(type, onInput, { capture: true });
      win?.removeEventListener('blur', onBlur);
      win?.removeEventListener('pagehide', onPageHide);
    });
  }

  /** Binds the store to a run. Switching to another run leaves the previous one (its session stops). */
  attach(visualizationId: number | null): void {
    if (visualizationId === this.visualizationId) return;
    this.stop('left');
    this.teardown();
    this.generation += 1;
    this.visualizationId = visualizationId;
    this.session.set(null);
    this.starting.set(false);
    this.error.set(null);
    this.opens.set(new Map());
  }

  /** Live button (D10: starts on click). Also "Start again" after an idle stop and "Try again" after a failure. */
  start(): void {
    const id = this.visualizationId;
    if (id === null || this.starting() || this.active()) return;
    const generation = this.generation;
    this.starting.set(true);
    this.error.set(null);
    this.markActivity();
    this.call(this.api.startLive(id), generation, {
      next: (session) => {
        this.starting.set(false);
        this.applySession(session);
      },
      error: (e) => {
        this.starting.set(false);
        this.error.set(userMessageFor(e));
      },
    });
  }

  /**
   * Asks the session for the hosts of a component's render group, once per (component, state) and session. Switching
   * the state tab opens the new state (D10: Live starts from the open state tab).
   */
  ensureOpen(componentId: number, stateName: string, sides: LiveSides = BOTH_SIDES): void {
    const id = this.visualizationId;
    const session = this.session();
    if (id === null || session?.status !== 'ready') return;
    const key = openKey(componentId, stateName);
    if (this.opens().has(key)) return;
    const generation = this.generation;
    this.setOpen(key, { componentId, stateName, sides, inFlight: true, error: null });
    this.markActivity();
    this.call(this.api.openLive(id, { componentId, stateName }), generation, {
      next: (next) => {
        this.setOpen(key, { componentId, stateName, sides, inFlight: false, error: null });
        this.applySession(next);
      },
      error: (e) => {
        this.setOpen(key, { componentId, stateName, sides, inFlight: false, error: userMessageFor(e) });
        // 409 "Live mode is not running for this run." and friends: learn the real state at once.
        this.pollNow();
      },
    });
  }

  /** Try again for a side that failed or was stopped, or after a failed open. */
  reopen(componentId: number, stateName: string, sides: LiveSides = BOTH_SIDES): void {
    const key = openKey(componentId, stateName);
    const record = this.opens().get(key);
    if (record?.inFlight) return;
    this.opens.update((map) => {
      const next = new Map(map);
      next.delete(key);
      return next;
    });
    this.ensureOpen(componentId, stateName, sides);
  }

  /** Why the last open of this (component, state) failed, if it did. */
  openErrorFor(componentId: number, stateName: string): string | null {
    return this.opens().get(openKey(componentId, stateName))?.error ?? null;
  }

  /** The host serving `componentId` on `side`, preferring a ready one. Reads the session signal. */
  hostFor(componentId: number, side: LiveSide): LiveHostView | null {
    const hosts = (this.session()?.hosts ?? []).filter((h) => h.side === side && h.componentIds.includes(componentId));
    return hosts.sort((a, b) => HOST_RANK[a.status] - HOST_RANK[b.status])[0] ?? null;
  }

  /** The live page URL for one side once its host is ready (16 §14.6); null otherwise. */
  urlFor(componentId: number, stateName: string, side: LiveSide): string | null {
    if (this.session()?.status !== 'ready') return null;
    const host = this.hostFor(componentId, side);
    if (host?.status !== 'ready') return null;
    const parentOrigin = this.document.defaultView?.location.origin ?? '';
    return liveSideUrl(host, componentId, stateName, parentOrigin);
  }

  /** The reviewer used the page or a live side. Ignored while the tab is hidden (16 §15.6). */
  markActivity(): void {
    if (this.document.visibilityState === 'visible') this.activity = true;
  }

  /**
   * Stops the run's session: `left` when leaving the run, `user` from an explicit stop. No-op without an active
   * session. The request is not tied to the page's lifetime, so it still goes out while the page is destroyed.
   */
  stop(reason: 'user' | 'left'): void {
    const id = this.visualizationId;
    const session = this.session();
    if (id === null || (!this.active() && !this.starting())) return;
    this.generation += 1;
    this.starting.set(false);
    this.stopHeartbeat();
    this.api.stopLive(id, { reason }).subscribe({
      error: () => {
        /* best effort: the session also stops after 90 s without heartbeats */
      },
    });
    if (session !== null) this.applyLocalStatus('stopping', reason);
  }

  private leaveWithBeacon(): void {
    const id = this.visualizationId;
    if (id === null || (!this.active() && !this.starting())) return;
    this.api.stopLiveBeacon(id);
    this.generation += 1;
    this.starting.set(false);
    this.stopHeartbeat();
    if (this.session() !== null) this.applyLocalStatus('stopping', 'left');
  }

  private applyLocalStatus(status: LiveSessionStatus, reason: 'user' | 'left' | null): void {
    this.session.update((s) => (s === null ? s : { ...s, status, stopReason: reason ?? s.stopReason }));
    this.schedulePoll();
  }

  /** Takes a session from the API. An older session than the one shown is ignored; a new one resets the opens. */
  private applySession(next: LiveSessionView): void {
    const current = this.session();
    if (current !== null && next.id < current.id) return;
    if (current?.id === next.id && STATUS_RANK[next.status] < STATUS_RANK[current.status]) {
      this.schedulePoll();
      return;
    }
    if (current?.id !== next.id) this.opens.set(new Map());
    this.session.set(next);
    this.syncHeartbeat();
    this.schedulePoll();
  }

  private setOpen(key: string, record: OpenRecord): void {
    this.opens.update((map) => new Map(map).set(key, record));
  }

  // ----- polling -----

  private shouldPoll(): boolean {
    const s = this.session();
    return !this.destroyed && s !== null && POLLED_STATUSES.includes(s.status);
  }

  private pollDelay(): number {
    return this.session()?.status === 'starting' || this.pendingOpen() ? LIVE_POLL_FAST_MS : LIVE_POLL_SLOW_MS;
  }

  /** (Re)arms the next poll at the current cadence; an in-flight poll re-arms when it answers. */
  private schedulePoll(): void {
    this.pollTimer?.unsubscribe();
    this.pollTimer = null;
    if (!this.shouldPoll() || this.pollRequest !== null) return;
    this.pollTimer = timer(this.pollDelay()).subscribe(() => {
      this.pollTimer = null;
      this.pollNow();
    });
  }

  private pollNow(): void {
    const id = this.visualizationId;
    if (id === null || this.destroyed || this.pollRequest !== null) return;
    this.pollTimer?.unsubscribe();
    this.pollTimer = null;
    const generation = this.generation;
    const request = new Subscription();
    this.pollRequest = request;
    const done = (): void => {
      if (this.pollRequest === request) this.pollRequest = null;
    };
    request.add(
      this.api.getLive(id).subscribe({
        next: (session) => {
          done();
          if (generation === this.generation || this.session()?.id === session.id) this.applySession(session);
          else this.schedulePoll();
        },
        error: (e: unknown) => {
          done();
          if (toApiError(e).isNotFound) this.applyLocalStatus('stopped', null);
          else this.schedulePoll();
        },
      }),
    );
  }

  // ----- heartbeat -----

  /** Runs the heartbeat while the session is starting or ready, at the session's own interval. */
  private syncHeartbeat(): void {
    const s = this.session();
    if (s === null || !HEARTBEAT_STATUSES.includes(s.status)) {
      this.stopHeartbeat();
      return;
    }
    const intervalMs = s.heartbeatIntervalMs > 0 ? s.heartbeatIntervalMs : DEFAULT_HEARTBEAT_MS;
    if (this.heartbeat?.sessionId === s.id && this.heartbeat.intervalMs === intervalMs) return;
    this.stopHeartbeat();
    this.activity = false;
    const sub = timer(intervalMs, intervalMs).subscribe(() => {
      this.sendHeartbeat();
    });
    this.heartbeat = { sessionId: s.id, intervalMs, sub };
  }

  private stopHeartbeat(): void {
    this.heartbeat?.sub.unsubscribe();
    this.heartbeat = null;
  }

  private sendHeartbeat(): void {
    const id = this.visualizationId;
    if (id === null) return;
    const active = this.activity;
    this.activity = false;
    const generation = this.generation;
    this.call(this.api.heartbeatLive(id, { active }), generation, {
      next: (res) => {
        if (res.status !== this.session()?.status) this.pollNow();
      },
      error: (e) => {
        if (!e.isNotFound) return;
        // The session is gone (idle, heartbeat loss, deleted run): show it stopped and fetch the reason.
        this.stopHeartbeat();
        this.applyLocalStatus('stopped', null);
        this.pollNow();
      },
    });
  }

  // ----- plumbing -----

  /** Drops answers that arrive after the run changed, the session was stopped or the page was destroyed. */
  private call<T>(
    source: Observable<T>,
    generation: number,
    handlers: { next: (value: T) => void; error: (error: ApiError) => void },
  ): void {
    const current = (): boolean => generation === this.generation && !this.destroyed;
    const sub = new Subscription();
    this.requests.add(sub);
    sub.add(() => {
      this.requests.delete(sub);
    });
    sub.add(
      source.subscribe({
        next: (value) => {
          if (current()) handlers.next(value);
        },
        error: (e: unknown) => {
          sub.unsubscribe();
          if (current()) handlers.error(toApiError(e));
        },
        complete: () => {
          sub.unsubscribe();
        },
      }),
    );
  }

  private teardown(): void {
    for (const sub of [...this.requests]) sub.unsubscribe();
    this.stopHeartbeat();
    this.pollTimer?.unsubscribe();
    this.pollTimer = null;
    this.pollRequest?.unsubscribe();
    this.pollRequest = null;
  }
}
