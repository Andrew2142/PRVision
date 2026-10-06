import { type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { toApiError } from '../models/api-error.model';
import { NotificationService } from '../services/notification.service';
import { userMessageFor } from '../utils/error-messages.util';
import { SUPPRESS_ERROR_TOAST } from './http-context-tokens';

/**
 * Maps every HTTP failure to `ApiError` and toasts it once unless the request set `SUPPRESS_ERROR_TOAST`.
 * Never logs: request bodies may carry secrets; the browser Network tab is the debugging tool.
 */
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const notifications = inject(NotificationService);
  return next(req).pipe(
    catchError((error: unknown) => {
      const apiError = toApiError(error);
      if (!req.context.get(SUPPRESS_ERROR_TOAST)) notifications.error(userMessageFor(apiError));
      return throwError(() => apiError);
    }),
  );
};
