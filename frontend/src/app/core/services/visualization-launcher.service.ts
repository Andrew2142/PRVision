import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { type Observable, catchError, filter, map, of, tap } from 'rxjs';
import { type ApiError, toApiError } from '../models/api-error.model';
import { type VisualizationCreateRequest } from '../models/visualization.model';
import { errorCopyFor, userMessageFor } from '../utils/error-messages.util';
import { ApiService } from './api.service';
import { NotificationService } from './notification.service';
import { RunAlertService } from './run-alert.service';

/** One flow for every "Visualize" button (13 §5.3): create → queued toast → navigate to live progress. */
@Injectable({ providedIn: 'root' })
export class VisualizationLauncherService {
  private readonly api = inject(ApiService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly runAlerts = inject(RunAlertService);

  /**
   * Emits the new visualization id (after navigating to it) or null (after handling the error), then completes.
   * Never errors. createVisualization is silent, so this method is the only place its errors are shown.
   */
  launch(request: VisualizationCreateRequest, label: string): Observable<number | null> {
    // Inside the Start click, so the browser shows the prompt; the run can then call the user back when it ends.
    this.runAlerts.requestPermission();
    return this.api.createVisualization(request).pipe(
      map(({ visualizationId }) => visualizationId),
      tap((visualizationId) => {
        this.notifications.queued(`Visualization queued: ${label}. Opening live progress…`);
        void this.router.navigate(['/visualizations', visualizationId]);
      }),
      catchError((error: unknown) => {
        this.handleError(toApiError(error));
        return of(null);
      }),
    );
  }

  private handleError(error: ApiError): void {
    const copy = errorCopyFor(error);
    const route = copy.actionRoute;
    if (route) {
      // github_token_missing, github_unauthorized, ai_not_configured, ai_unauthorized
      this.notifications
        .promptAction({
          title: copy.title,
          message: copy.message,
          actionLabel: copy.actionLabel ?? 'Open settings',
          dismissText: 'Not now',
        })
        .pipe(filter(Boolean))
        .subscribe(() => void this.router.navigateByUrl(route)); // completes when the dialog closes
      return;
    }
    if (error.is('working_tree_clean')) {
      this.notifications.info(copy.message);
      return;
    }
    this.notifications.error(userMessageFor(error));
  }
}
