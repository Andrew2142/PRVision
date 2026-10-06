import { Injectable, inject, signal } from '@angular/core';
import { catchError, exhaustMap, map, of, timer } from 'rxjs';
import { HEALTH_POLL_MS } from '../constants/polling.constants';
import { ApiService } from './api.service';

export type ApiHealth = 'unknown' | 'online' | 'degraded' | 'offline';

/** Polls GET /api/health for the top-bar pill. `degraded` = Postgres or Redis down (00 §14.4). */
@Injectable({ providedIn: 'root' })
export class HealthService {
  private readonly api = inject(ApiService);
  private readonly statusSignal = signal<ApiHealth>('unknown');
  readonly status = this.statusSignal.asReadonly();
  private started = false;

  /** Idempotent. Root service: the subscription intentionally lives as long as the app (no destroy). */
  start(): void {
    if (this.started) return;
    this.started = true;
    timer(0, HEALTH_POLL_MS)
      .pipe(
        exhaustMap(() =>
          // Silent: never toasts.
          this.api.getHealth().pipe(
            map((h): ApiHealth => (h.status === 'ok' ? 'online' : 'degraded')),
            catchError(() => of<ApiHealth>('offline')),
          ),
        ),
      )
      .subscribe((s) => {
        this.statusSignal.set(s);
      });
  }
}
