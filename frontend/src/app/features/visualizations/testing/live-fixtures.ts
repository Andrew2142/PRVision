import { type LiveHostView, type LiveSessionView } from '../../../core/models/live-session.model';

/** A ready React host on 127.0.0.1 serving component 11 on `side`. */
export function liveHost(overrides: Partial<LiveHostView> = {}): LiveHostView {
  const side = overrides.side ?? 'head';
  return {
    side,
    groupKey: 'g1',
    componentIds: [11],
    status: 'ready',
    origin: side === 'base' ? 'http://127.0.0.1:51001' : 'http://127.0.0.1:51002',
    harnessUrlPath: '/.prvision-harness/index.html',
    error: null,
    ...overrides,
  };
}

/** GET/POST …/live answer (16 §14.6). Defaults: session 3 of run 7, ready, no hosts yet. */
export function liveSession(overrides: Partial<LiveSessionView> = {}): LiveSessionView {
  return {
    id: 3,
    visualizationId: 7,
    status: 'ready',
    stopReason: null,
    errorMessage: null,
    hosts: [],
    idleTimeoutMs: 600_000,
    heartbeatIntervalMs: 30_000,
    createdAt: '2026-10-07T10:00:00.000Z',
    readyAt: '2026-10-07T10:00:20.000Z',
    stoppedAt: null,
    ...overrides,
  };
}

/** Both sides of component 11 ready. */
export function readyHosts(): LiveHostView[] {
  return [liveHost({ side: 'base' }), liveHost({ side: 'head' })];
}
