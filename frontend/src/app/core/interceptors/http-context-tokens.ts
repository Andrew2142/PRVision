import { HttpContextToken } from '@angular/common/http';

/** true → the error interceptor does not toast; the caller renders the error itself (01 §5.14.3). */
export const SUPPRESS_ERROR_TOAST = new HttpContextToken<boolean>(() => false);
